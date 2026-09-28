import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { after, test } from 'node:test';
import { MongoClient } from 'mongodb';

const mongoUrl = process.env.MONGO_URL;
if (!mongoUrl) throw new Error('Set MONGO_URL to a disposable MongoDB instance before running integration tests.');

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

test('login, password change, graph edits and optimistic conflicts', async () => {
  const port = await freePort();
  const dbName = `memoryplace_test_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  const server = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, MONGO_URL: mongoUrl, MONGO_DB_NAME: dbName, PORT: String(port), HOST: '127.0.0.1' },
    stdio: 'ignore',
  });
  const client = new MongoClient(mongoUrl);
  after(async () => { server.kill(); await client.connect(); await client.db(dbName).dropDatabase(); await client.close(); });
  const base = `http://127.0.0.1:${port}/api`;
  let healthy = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { const response = await fetch(`${base}/health`); if (response.ok) { healthy = true; break; } } catch { /* startup */ }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.equal(healthy, true, 'API should start');

  let cookie = '';
  async function call(path: string, method = 'GET', body?: unknown) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return { status: response.status, data: await response.json() as Record<string, any> };
  }

  assert.equal((await call('/boards')).status, 401);
  assert.equal((await call('/auth/login', 'POST', { username: 'admin', password: 'wrong' })).status, 401);
  const login = await call('/auth/login', 'POST', { username: 'admin', password: '1234' });
  assert.equal(login.status, 200);
  assert.equal(login.data.user.mustChangePassword, true);
  assert.equal((await call('/boards')).status, 403);
  const changed = await call('/auth/password', 'PATCH', { currentPassword: '1234', newPassword: 'test-password-2026' });
  assert.equal(changed.status, 200);
  assert.equal(changed.data.user.mustChangePassword, false);

  const boardList = await call('/boards');
  assert.equal(boardList.status, 200);
  assert.equal(boardList.data.boards.length, 1);
  const boardId = boardList.data.boards[0].id as string;
  const initial = await call(`/boards/${boardId}/graph`);
  assert.equal(initial.data.nodes.length, 4);
  assert.equal(initial.data.edges.length, 3);
  assert.equal('body' in initial.data.nodes[0], false, 'graph response must omit note bodies');

  const created = await call(`/boards/${boardId}/notes`, 'POST', { title: '통합 테스트', position: { x: 8, y: 9, z: 10 }, nearNodeId: initial.data.nodes[0].id });
  assert.equal(created.status, 201);
  assert.equal(created.data.edge !== null, true);
  const duplicate = await call(`/boards/${boardId}/edges`, 'POST', { sourceNodeId: created.data.node.id, targetNodeId: initial.data.nodes[0].id });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.data.edge.id, created.data.edge.id, 'an automatic link should be reused in either direction');
  const noteId = created.data.note.id as string;
  const nodeId = created.data.node.id as string;
  const edited = await call(`/notes/${noteId}`, 'PATCH', { title: '수정한 제목', body: '본문 저장 확인', revision: 1 });
  assert.equal(edited.status, 200);
  assert.equal(edited.data.note.revision, 2);
  assert.equal((await call(`/notes/${noteId}`, 'PATCH', { title: '오래된 수정', revision: 1 })).status, 409);
  assert.equal((await call(`/notes/${noteId}`)).data.note.body, '본문 저장 확인');

  const moved = await call(`/boards/${boardId}/nodes/${nodeId}`, 'PATCH', { x: 18, y: 19, z: 20, scale: 1.6, revision: 1 });
  assert.equal(moved.status, 200);
  assert.equal(moved.data.node.scale, 1.6);
  const searched = await call(`/boards/${boardId}/search?q=${encodeURIComponent('수정한')}`);
  assert.equal(searched.data.results[0].noteId, noteId);
  const literalSearch = await call(`/boards/${boardId}/search?q=${encodeURIComponent('.')}`);
  assert.equal(literalSearch.status, 200);
  assert.equal(literalSearch.data.results.length, 0, 'search punctuation must be treated literally');
  assert.equal((await call(`/boards/${boardId}/search?q=${encodeURIComponent('[')}`)).status, 200);
  const exported = await call(`/boards/${boardId}/export`);
  assert.equal(exported.data.notes.length, 5);
  const graph = await call(`/boards/${boardId}/graph`);
  assert.equal(graph.data.nodes.find((node: { id: string }) => node.id === nodeId).x, 18);

  const batchFirst = await call(`/boards/${boardId}/notes`, 'POST', { title: '일괄 삭제 첫 메모', position: { x: 28, y: 9, z: 10 }, nearNodeId: initial.data.nodes[0].id });
  const batchSecond = await call(`/boards/${boardId}/notes`, 'POST', { title: '일괄 삭제 둘째 메모', position: { x: 38, y: 9, z: 10 }, nearNodeId: initial.data.nodes[0].id });
  const bulkNotes = await call(`/boards/${boardId}/notes`, 'DELETE', { noteIds: [batchFirst.data.note.id, batchSecond.data.note.id] });
  assert.equal(bulkNotes.status, 200);
  assert.equal(bulkNotes.data.deletedCount, 2);
  const graphAfterBulkNotes = await call(`/boards/${boardId}/graph`);
  assert.equal(graphAfterBulkNotes.data.nodes.some((node: { noteId: string }) => node.noteId === batchFirst.data.note.id), false);
  assert.equal(graphAfterBulkNotes.data.nodes.some((node: { noteId: string }) => node.noteId === batchSecond.data.note.id), false);

  const deleteAllFirst = await call(`/boards/${boardId}/notes`, 'POST', { title: '전체 삭제 첫 메모', position: { x: 48, y: 9, z: 10 } });
  const deleteAllSecond = await call(`/boards/${boardId}/notes`, 'POST', { title: '전체 삭제 둘째 메모', position: { x: 58, y: 9, z: 10 } });
  const deletedAllNotes = await call(`/boards/${boardId}/notes`, 'DELETE', { all: true, excludedNoteIds: [noteId, deleteAllSecond.data.note.id] });
  assert.equal(deletedAllNotes.status, 200);
  assert.equal((await call(`/notes/${deleteAllFirst.data.note.id}`)).status, 404);
  assert.equal((await call(`/notes/${deleteAllSecond.data.note.id}`)).status, 200);

  const disposableBoard = await call('/boards', 'POST', { title: '일괄 삭제 테스트 공간' });
  assert.equal(disposableBoard.status, 201);
  const disposableBoardId = disposableBoard.data.board.id as string;
  const disposableNote = await call(`/boards/${disposableBoardId}/notes`, 'POST', { title: '공간과 함께 삭제될 메모', position: { x: 0, y: 0, z: 0 } });
  assert.equal(disposableNote.status, 201);
  const bulkBoards = await call('/boards', 'DELETE', { boardIds: [disposableBoardId] });
  assert.equal(bulkBoards.status, 200);
  assert.deepEqual(bulkBoards.data.deletedBoardIds, [disposableBoardId]);
  assert.equal((await call(`/boards/${disposableBoardId}/graph`)).status, 404);

  assert.equal((await call(`/notes/${noteId}`, 'DELETE')).status, 200);
  assert.equal((await call(`/notes/${noteId}`)).status, 404);
  assert.equal((await call('/auth/logout', 'POST')).status, 200);
  assert.equal((await call('/boards')).status, 401);
});
