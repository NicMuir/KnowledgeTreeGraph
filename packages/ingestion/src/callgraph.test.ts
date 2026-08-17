import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildCodeTree, buildCallGraph } from './callgraph';

const TS_FIXTURE = `
import Fastify from 'fastify';

export class UserService {
  find(id: string) {
    return lookup(id);
  }
}

function lookup(id: string) {
  return { id };
}

export async function userRoutes(app: any) {
  app.get('/users/:id', async (req: any) => {
    const svc = new UserService();
    return svc.find(req.params.id);
  });
  app.post('/users', createUser);
}

function createUser(req: any) {
  return lookup(req.body.id);
}
`;

test('buildCodeTree maps route > class > function', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-tree-'));
  fs.writeFileSync(path.join(dir, 'users.ts'), TS_FIXTURE);

  const tree = buildCodeTree(dir, [{ filePath: 'users.ts', language: 'typescript' }]);
  const byKind = (k: string) => tree.nodes.filter((n) => n.kind === k);

  // nodes
  assert.strictEqual(byKind('class').length, 1, 'one class');
  assert.strictEqual(byKind('route').length, 2, 'two routes');
  assert.ok(byKind('route').some((n) => n.name === 'GET /users/:id'));
  assert.ok(byKind('route').some((n) => n.name === 'POST /users'));
  assert.ok(byKind('method').some((n) => n.name === 'find'));

  const node = (name: string) => tree.nodes.find((n) => n.name === name)!;
  const hasEdge = (from: string, to: string, kind: string) =>
    tree.edges.some((e) => e.from === node(from).id && e.to === node(to).id && e.kind === kind);

  // class contains method
  assert.ok(hasEdge('UserService', 'find', 'contains'), 'class contains method');
  // method calls function
  assert.ok(hasEdge('find', 'lookup', 'calls'), 'method calls function');
  // route with named handler contains it
  assert.ok(hasEdge('POST /users', 'createUser', 'contains'), 'route contains named handler');
  // route with inline handler picks up calls from its body
  assert.ok(hasEdge('GET /users/:id', 'find', 'calls'), 'inline route handler calls method');

  fs.rmSync(dir, { recursive: true, force: true });
});

const PHP_ROUTES_FIXTURE = `<?php
use App\\Http\\Controllers\\UserController;

Route::get('/users/{id}', [UserController::class, 'show']);
Route::post('/users', 'UserController@store');
Route::delete('/users/{id}', function ($id) {
    return destroyUser($id);
});
`;

const PHP_CONTROLLER_FIXTURE = `<?php
namespace App\\Http\\Controllers;

class UserController {
    public function show($id) {
        return $this->findUser($id);
    }
    public function store($req) {
        return makeUser($req);
    }
    private function findUser($id) {
        return $id;
    }
}

function makeUser($req) { return $req; }
function destroyUser($id) { return $id; }
`;

test('buildCodeTree maps Laravel routes > controller > methods', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-tree-php-'));
  fs.writeFileSync(path.join(dir, 'web.php'), PHP_ROUTES_FIXTURE);
  fs.writeFileSync(path.join(dir, 'UserController.php'), PHP_CONTROLLER_FIXTURE);

  const files = [
    { filePath: 'web.php', language: 'php' },
    { filePath: 'UserController.php', language: 'php' },
  ];
  const tree = buildCodeTree(dir, files);

  const node = (name: string) => tree.nodes.find((n) => n.name === name)!;
  const hasEdge = (from: string, to: string, kind: string) =>
    tree.edges.some((e) => e.from === node(from).id && e.to === node(to).id && e.kind === kind);

  assert.ok(node('UserController')?.kind === 'class', 'controller class found');
  assert.ok(node('GET /users/{id}')?.kind === 'route', 'GET route found');
  assert.ok(node('show')?.kind === 'method', 'method found');

  // Route -> controller method via [Controller::class, 'method']
  assert.ok(hasEdge('GET /users/{id}', 'show', 'contains'), 'array-style handler resolved');
  // Route -> controller method via 'Controller@method'
  assert.ok(hasEdge('POST /users', 'store', 'contains'), 'string-style handler resolved');
  // Closure route picks up its calls
  assert.ok(hasEdge('DELETE /users/{id}', 'destroyUser', 'calls'), 'closure route calls resolved');
  // Class containment + method calls
  assert.ok(hasEdge('UserController', 'show', 'contains'), 'class contains method');
  assert.ok(hasEdge('show', 'findUser', 'calls'), 'php method call edge');
  assert.ok(hasEdge('store', 'makeUser', 'calls'), 'php function call edge');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('buildCallGraph legacy view still returns functions + call edges', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-tree-'));
  fs.writeFileSync(path.join(dir, 'users.ts'), TS_FIXTURE);

  const graph = buildCallGraph(dir, [{ filePath: 'users.ts', language: 'typescript' }]);
  assert.ok(graph.nodes.every((n) => n.kind === 'function' || n.kind === 'method'));
  assert.ok(graph.edges.length >= 1, 'has call edges');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('calls edges carry resolution confidence', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-conf-'));
  fs.writeFileSync(path.join(dir, 'users.ts'), TS_FIXTURE);
  const tree = buildCodeTree(dir, [{ filePath: 'users.ts', language: 'typescript' }]);
  const calls = tree.edges.filter((e) => e.kind === 'calls');
  assert.ok(calls.length >= 1, 'has call edges');
  assert.ok(calls.every((e) => typeof e.confidence === 'number' && e.confidence > 0), 'all calls scored');
  // same-file resolution (find -> lookup) is high confidence
  const find = tree.nodes.find((n) => n.name === 'find')!;
  const lookup = tree.nodes.find((n) => n.name === 'lookup')!;
  const edge = calls.find((e) => e.from === find.id && e.to === lookup.id)!;
  assert.strictEqual(edge.confidence, 0.9, 'same-file call is 0.9');
  fs.rmSync(dir, { recursive: true, force: true });
});

// Outbound HTTP call-site extraction across all four languages.
const HTTP_TS = `
async function loadUser(id: string) {
  const base = process.env.API;
  await fetch(\`\${base}/users/\${id}\`);
  await axios.post('/orders', { id });
  await this.http.get('https://svc.internal/health?full=1');
}
`;
const HTTP_PY = `
def sync_user(id):
    requests.get(f"{BASE}/users/{id}")
    session.request("DELETE", f"/orders/{id}")
`;
const HTTP_GO = `
package main
func fetchUser(id string) {
	http.Get("http://svc/users/1")
	http.NewRequest("PUT", "/orders/1", nil)
}
`;
const HTTP_PHP = `<?php
function loadUser($id) {
    $client->get('/users/1');
    Http::request('POST', '/orders');
}
`;

// Laravel route group prefixes + api.php global /api mount must land in the route path,
// so cross-service matching sees the full path a client actually calls.
const LARAVEL_API_FIXTURE = `<?php
use App\\Http\\Controllers\\AuthController;

Route::get('/status', [AuthController::class, 'status']);
Route::prefix('auth')->group(function () {
    Route::post('/login', [AuthController::class, 'login']);
    Route::prefix('password')->group(function () {
        Route::post('/reset', [AuthController::class, 'reset']);
    });
});
Route::group(['prefix' => 'bookings'], function () {
    Route::get('/by_code/{code}', [AuthController::class, 'byCode']);
});
`;

test('Laravel route prefixes + api.php mount resolve to full paths', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-laravel-'));
  fs.mkdirSync(path.join(dir, 'routes'));
  fs.writeFileSync(path.join(dir, 'routes', 'api.php'), LARAVEL_API_FIXTURE);

  const tree = buildCodeTree(dir, [{ filePath: 'routes/api.php', language: 'php' }]);
  const routes = tree.nodes.filter((n) => n.kind === 'route').map((n) => n.name).sort();

  assert.ok(routes.includes('GET /api/status'), `api.php mount → /api (got ${routes})`);
  assert.ok(routes.includes('POST /api/auth/login'), 'prefix(auth) applied');
  assert.ok(routes.includes('POST /api/auth/password/reset'), 'nested prefix compounds');
  assert.ok(routes.includes('GET /api/bookings/by_code/{code}'), 'group([prefix]) applied');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('HTTP calls in test files are ignored', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-testfile-'));
  fs.mkdirSync(path.join(dir, 'tests'));
  fs.writeFileSync(path.join(dir, 'tests', 'ExampleTest.php'), `<?php
class ExampleTest {
  public function test_root() { $this->get('/api/x'); }
}
`);
  const tree = buildCodeTree(dir, [{ filePath: 'tests/ExampleTest.php', language: 'php' }]);
  assert.strictEqual(tree.nodes.filter((n) => n.kind === 'http_call').length, 0, 'no http_call from test file');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('collectHttpCalls extracts method + path across languages', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-http-'));
  fs.writeFileSync(path.join(dir, 'a.ts'), HTTP_TS);
  fs.writeFileSync(path.join(dir, 'b.py'), HTTP_PY);
  fs.writeFileSync(path.join(dir, 'c.go'), HTTP_GO);
  fs.writeFileSync(path.join(dir, 'd.php'), HTTP_PHP);

  const tree = buildCodeTree(dir, [
    { filePath: 'a.ts', language: 'typescript' },
    { filePath: 'b.py', language: 'python' },
    { filePath: 'c.go', language: 'go' },
    { filePath: 'd.php', language: 'php' },
  ]);
  const http = tree.nodes.filter((n) => n.kind === 'http_call').map((n) => n.name).sort();

  // interpolated base URL prefix is stripped to the path; scheme+host dropped; query dropped
  assert.ok(http.includes('GET /users/{}'), `ts fetch template + py f-string → GET /users/{} (got ${http})`);
  assert.ok(http.includes('POST /orders'), 'ts axios.post + php Http::request');
  assert.ok(http.includes('GET /health'), 'ts this.http.get with host+query stripped');
  assert.ok(http.includes('DELETE /orders/{}'), 'py session.request(method, url)');
  assert.ok(http.includes('PUT /orders/1'), 'go http.NewRequest');
  assert.ok(http.includes('GET /users/1'), 'go http.Get with host + php $client->get');

  // each http_call node is contained by its enclosing function
  const httpNode = tree.nodes.find((n) => n.name === 'POST /orders' && n.language === 'typescript')!;
  assert.ok(
    tree.edges.some((e) => e.to === httpNode.id && e.kind === 'contains'),
    'http_call is contained by its caller',
  );
  fs.rmSync(dir, { recursive: true, force: true });
});
