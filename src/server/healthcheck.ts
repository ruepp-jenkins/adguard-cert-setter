import { request as httpRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { loadConfig } from './config.js';

const config = loadConfig();
const options: RequestOptions = {
  hostname: '127.0.0.1',
  port: config.port,
  path: '/health',
  method: 'GET',
};

const handleResponse = (response: IncomingMessage): void => {
  response.resume();
  if (response.statusCode !== 200) {
    process.stderr.write(`Health check returned HTTP ${response.statusCode ?? 'unknown'}.\n`);
    process.exitCode = 1;
  }
};

const request = config.tls
  ? httpsRequest({ ...options, rejectUnauthorized: false }, handleResponse)
  : httpRequest(options, handleResponse);

request.setTimeout(4_000, () => request.destroy(new Error('Health check timed out.')));
request.on('error', (error: Error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
request.end();
