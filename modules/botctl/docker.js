// modules/botctl/docker.js — Docker Engine API wrapper via unix socket (v0.5.1)
// v0.5.1: createContainer accepts extraHosts for host-gateway access

import http from 'http';

const SOCKET = '/var/run/docker.sock';
const API_VERSION = 'v1.43';
const PREFIX = '/' + API_VERSION;

function request(method, path, body = null, opts = {}) {
  return new Promise((resolve, reject) => {
    const reqOpts = {
      socketPath: SOCKET,
      path: PREFIX + path,
      method,
      headers: { host: 'localhost' },
    };
    let bodyStr = null;
    if (body !== null) {
      bodyStr = JSON.stringify(body);
      reqOpts.headers['content-type'] = 'application/json';
      reqOpts.headers['content-length'] = Buffer.byteLength(bodyStr);
    }
    const req = http.request(reqOpts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (opts.raw) return resolve({ status: res.statusCode, headers: res.headers, body: buf });
        const txt = buf.toString('utf8');
        if (res.statusCode >= 400) {
          let msg = txt;
          try { msg = JSON.parse(txt).message || txt; } catch {}
          return reject(new Error('docker ' + method + ' ' + path + ': ' + res.statusCode + ' ' + msg));
        }
        if (!txt) return resolve(null);
        try { resolve(JSON.parse(txt)); } catch { resolve(txt); }
      });
    });
    req.on('error', reject);
    req.setTimeout(opts.timeoutMs || 30000, () => req.destroy(new Error('docker request timeout')));
    if (bodyStr !== null) req.write(bodyStr);
    req.end();
  });
}

export const ping    = () => request('GET', '/_ping');
export const version = () => request('GET', '/version');

export async function listContainers({ all = true, label = null } = {}) {
  const filters = {};
  if (label) filters.label = [label];
  const qs = new URLSearchParams({ all: all ? '1' : '0', filters: JSON.stringify(filters) });
  return request('GET', '/containers/json?' + qs);
}

export async function inspectContainer(id) {
  return request('GET', '/containers/' + id + '/json');
}

export async function createContainer({
  name, image, env, memMB, cpuFrac, pidsLimit, binds, labels,
  extraHosts = [],
  restartPolicy = 'unless-stopped',
}) {
  const body = {
    Image: image,
    Env: env,
    Labels: labels || {},
    HostConfig: {
      Memory:        memMB * 1024 * 1024,
      NanoCpus:      Math.round(cpuFrac * 1e9),
      PidsLimit:     pidsLimit || 128,
      CapDrop:       ['ALL'],
      ReadonlyRootfs: true,
      Tmpfs:         { '/tmp': 'rw,noexec,nosuid,size=64m' },
      RestartPolicy: { Name: restartPolicy },
      Binds:         binds || [],
      ExtraHosts:    extraHosts,
      NetworkMode:   'bridge',
      AutoRemove:    false,
      LogConfig:     { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' } },
    },
  };
  const qs = new URLSearchParams({ name });
  return request('POST', '/containers/create?' + qs, body);
}

export const startContainer   = (id)                  => request('POST',   '/containers/' + id + '/start');
export const stopContainer    = (id, timeoutSec = 10) => request('POST',   '/containers/' + id + '/stop?t=' + timeoutSec);
export const restartContainer = (id, timeoutSec = 10) => request('POST',   '/containers/' + id + '/restart?t=' + timeoutSec);
export const removeContainer  = (id, force = false)   => request('DELETE', '/containers/' + id + '?force=' + (force ? 'true' : 'false'));

export async function tailLogs(id, { tail = 100 } = {}) {
  const qs = new URLSearchParams({
    stdout: '1', stderr: '1', tail: String(tail), timestamps: '1',
  });
  const res = await request('GET', '/containers/' + id + '/logs?' + qs, null, { raw: true });
  return demuxLogs(res.body);
}

function demuxLogs(buf) {
  const out = [];
  let i = 0;
  while (i + 8 <= buf.length) {
    const stream = buf[i];
    const len = buf.readUInt32BE(i + 4);
    const start = i + 8;
    const end = start + len;
    if (end > buf.length) break;
    out.push({
      stream: stream === 1 ? 'stdout' : stream === 2 ? 'stderr' : 'unknown',
      text: buf.slice(start, end).toString('utf8'),
    });
    i = end;
  }
  return out;
}
