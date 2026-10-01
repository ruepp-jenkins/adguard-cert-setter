import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createSecureContext } from 'node:tls';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { verify } from '@node-rs/argon2';
import { z } from 'zod';
import { AdGuardClient } from './adguard-client.js';
import type { AppConfig } from './config.js';
import { AppDatabase } from './database.js';
import { DeploymentService } from './deployment-service.js';
import { AppError } from './errors.js';
import { normalizeBaseUrl } from './url.js';

const sessionCookie = 'agh_session';
const mutatingMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const loginSchema = z.object({
  username: z.string().min(1).max(200),
  password: z.string().min(1).max(1000),
});
const targetCreateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  baseUrl: z.string().trim().min(1).max(2048),
  username: z.string().max(500),
  password: z.string().max(5000),
});
const targetUpdateSchema = targetCreateSchema.extend({ password: z.string().max(5000).optional() });
const settingsSchema = z.object({ verifyTargetTls: z.boolean() });
const deploymentSchema = z.object({
  certificatePem: z.string().min(1).max(1_000_000),
  privateKeyPem: z.string().min(1).max(1_000_000),
  passphrase: z.string().max(10_000).optional(),
});
const idParamsSchema = z.object({ id: z.uuid() });

function authVersion(passwordHash: string): string {
  return createHash('sha256').update(passwordHash).digest('hex');
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function isAuthenticated(request: FastifyRequest, database: AppDatabase, version: string): boolean {
  const token = request.cookies[sessionCookie];
  return Boolean(token && database.hasSession(token, version));
}

export interface BuiltApp {
  app: FastifyInstance;
  database: AppDatabase;
  deployments: DeploymentService;
}

export function buildApp(config: AppConfig): BuiltApp {
  let tlsOptions: { key: Buffer; cert: Buffer; passphrase?: string } | undefined;
  if (config.tls) {
    const key = readFileSync(config.tls.privateKeyFile);
    const cert = readFileSync(config.tls.certificateFile);
    tlsOptions = {
      key,
      cert,
      ...(config.tls.privateKeyPassphrase ? { passphrase: config.tls.privateKeyPassphrase } : {}),
    };
    createSecureContext(tlsOptions);
  }

  const app = Fastify({
    ...(tlsOptions ? { https: tlsOptions } : {}),
    bodyLimit: 2_100_000,
    trustProxy: true,
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'password',
          '*.password',
          'privateKeyPem',
          '*.privateKeyPem',
          'passphrase',
          '*.passphrase',
        ],
        censor: '[REDACTED]',
      },
    },
  });
  const database = new AppDatabase(config.dataDirectory);
  const deployments = new DeploymentService(
    database,
    { timeoutMs: config.adguardTimeoutMs, concurrency: config.deploymentConcurrency },
    app.log,
  );
  const version = authVersion(config.passwordHash);

  void app.register(cookie);
  void app.register(rateLimit, { global: false });
  void app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
      },
    },
  });

  app.addHook('onRequest', async (request) => {
    if (!mutatingMethods.has(request.method)) return;
    if (request.headers['sec-fetch-site'] === 'cross-site') {
      throw new AppError('Cross-site request rejected.', 403, 'CSRF_REJECTED');
    }
    const origin = request.headers.origin;
    if (!origin) return;
    const expected = config.publicUrl
      ? new URL(config.publicUrl).origin
      : `${request.protocol}://${request.headers.host ?? ''}`;
    if (origin !== expected) {
      throw new AppError('Request from an unknown origin rejected.', 403, 'CSRF_REJECTED');
    }
  });

  const requireAuth = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!isAuthenticated(request, database, version)) {
      await reply.code(401).send({ error: 'AUTH_REQUIRED', message: 'Authentication required.' });
    }
  };

  const requireIdle = (): void => {
    if (deployments.isActive()) {
      throw new AppError(
        'Targets and settings cannot be changed during a deployment.',
        409,
        'DEPLOYMENT_ACTIVE',
      );
    }
  };

  app.get('/health', async () => ({ status: 'ok' }));

  app.post(
    '/api/auth/login',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const input = loginSchema.parse(request.body);
      const usernameMatches = safeEqual(input.username, config.username);
      let passwordMatches = false;
      try {
        passwordMatches = await verify(config.passwordHash, input.password);
      } catch {
        throw new AppError('The configured password hash is invalid.', 500, 'INVALID_HASH');
      }
      if (!usernameMatches || !passwordMatches) {
        throw new AppError('The username or password is incorrect.', 401, 'LOGIN_FAILED');
      }
      const token = randomBytes(32).toString('base64url');
      database.createSession(token, version, Date.now() + config.sessionTtlMs);
      return reply
        .setCookie(sessionCookie, token, {
          path: '/',
          httpOnly: true,
          sameSite: 'strict',
          secure: config.cookieSecure,
          maxAge: Math.floor(config.sessionTtlMs / 1000),
        })
        .send({ authenticated: true, username: config.username });
    },
  );

  app.post('/api/auth/logout', { preHandler: requireAuth }, async (request, reply) => {
    const token = request.cookies[sessionCookie];
    if (token) database.deleteSession(token);
    return reply.clearCookie(sessionCookie, { path: '/' }).send({ authenticated: false });
  });

  app.get('/api/auth/session', async (request) => ({
    authenticated: isAuthenticated(request, database, version),
    ...(isAuthenticated(request, database, version) ? { username: config.username } : {}),
  }));

  app.get('/api/targets', { preHandler: requireAuth }, async () => database.listTargets());

  app.post('/api/targets', { preHandler: requireAuth }, async (request, reply) => {
    requireIdle();
    const input = targetCreateSchema.parse(request.body);
    const target = database.createTarget({ ...input, baseUrl: normalizeBaseUrl(input.baseUrl) });
    return reply.code(201).send(target);
  });

  app.put('/api/targets/:id', { preHandler: requireAuth }, async (request) => {
    requireIdle();
    const { id } = idParamsSchema.parse(request.params);
    const input = targetUpdateSchema.parse(request.body);
    const target = database.updateTarget(id, {
      ...input,
      baseUrl: normalizeBaseUrl(input.baseUrl),
    });
    if (!target) throw new AppError('Target not found.', 404, 'NOT_FOUND');
    return target;
  });

  app.delete('/api/targets/:id', { preHandler: requireAuth }, async (request, reply) => {
    requireIdle();
    const { id } = idParamsSchema.parse(request.params);
    if (!database.deleteTarget(id)) throw new AppError('Target not found.', 404, 'NOT_FOUND');
    return reply.code(204).send();
  });

  app.post('/api/targets/:id/test', { preHandler: requireAuth }, async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    const target = database.getTargetSecret(id);
    if (!target) throw new AppError('Target not found.', 404, 'NOT_FOUND');
    const client = new AdGuardClient(
      target,
      database.getSettings().verifyTargetTls,
      config.adguardTimeoutMs,
    );
    try {
      return { ok: true, ...(await client.test()) };
    } finally {
      await client.close();
    }
  });

  app.get('/api/settings', { preHandler: requireAuth }, async () => database.getSettings());
  app.put('/api/settings', { preHandler: requireAuth }, async (request) => {
    requireIdle();
    return database.setSettings(settingsSchema.parse(request.body));
  });

  app.post('/api/deployments', { preHandler: requireAuth }, async (request, reply) => {
    const input = deploymentSchema.parse(request.body);
    return reply.code(202).send(deployments.start(input));
  });
  app.get('/api/deployments', { preHandler: requireAuth }, async () => database.listDeployments());
  app.get('/api/deployments/:id', { preHandler: requireAuth }, async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    const deployment = database.getDeployment(id);
    if (!deployment) throw new AppError('Deployment not found.', 404, 'NOT_FOUND');
    return deployment;
  });

  const compiledClient = join(dirname(fileURLToPath(import.meta.url)), '../client');
  if (existsSync(join(compiledClient, 'index.html'))) {
    void app.register(fastifyStatic, { root: compiledClient, wildcard: false });
    app.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith('/api/')) {
        return reply.code(404).send({ error: 'NOT_FOUND', message: 'Route not found.' });
      }
      return reply.type('text/html').sendFile('index.html');
    });
  }

  app.setErrorHandler(async (error, _request, reply) => {
    if (error instanceof z.ZodError) {
      return reply.code(422).send({
        error: 'VALIDATION_ERROR',
        message: 'The submitted data is invalid.',
        details: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({ error: error.code, message: error.message });
    }
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'SQLITE_CONSTRAINT_UNIQUE'
    ) {
      return reply
        .code(409)
        .send({ error: 'DUPLICATE_TARGET', message: 'This target URL is already configured.' });
    }
    app.log.error({ err: error }, 'Unhandled API error');
    return reply.code(500).send({ error: 'INTERNAL_ERROR', message: 'Internal server error.' });
  });

  app.addHook('onClose', async () => database.close());
  return { app, database, deployments };
}
