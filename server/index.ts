import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import argon2 from 'argon2';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import type { Board, CameraState, Graph, GraphEdge, GraphNode, Note, User, Vec3 } from '../shared/types.js';

if (!process.env.MONGO_URL && existsSync('.env.local')) loadEnvFile('.env.local');
const mongoUrl = process.env.MONGO_URL;
if (!mongoUrl) throw new Error('MONGO_URL is required. See README.md.');

const client = new MongoClient(mongoUrl, { maxPoolSize: 12 });
await client.connect();
const db = client.db(process.env.MONGO_DB_NAME || 'memoryplace');
const app = Fastify({ logger: true, bodyLimit: 150_000 });
await app.register(cookie);

type UserDoc = { _id: ObjectId; username: string; passwordHash: string; role: 'admin'; mustChangePassword: boolean; createdAt: Date };
type BoardDoc = { _id: ObjectId; ownerId: ObjectId; title: string; cameraState: CameraState; revision: number; createdAt: Date; updatedAt: Date };
type NoteDoc = { _id: ObjectId; boardId: ObjectId; title: string; body: string; revision: number; createdAt: Date; updatedAt: Date };
type NodeDoc = { _id: ObjectId; boardId: ObjectId; noteId: ObjectId; x: number; y: number; z: number; scale: number; color: string; pinned: boolean; revision: number; updatedAt: Date };
type EdgeDoc = { _id: ObjectId; boardId: ObjectId; sourceNodeId: ObjectId; targetNodeId: ObjectId; kind: string; weight: number; createdAt: Date };
type SessionDoc = { _id: ObjectId; userId: ObjectId; tokenHash: string; expiresAt: Date };

const users = db.collection<UserDoc>('users');
const boards = db.collection<BoardDoc>('boards');
const notes = db.collection<NoteDoc>('notes');
const nodes = db.collection<NodeDoc>('nodes');
const edges = db.collection<EdgeDoc>('edges');
const sessions = db.collection<SessionDoc>('sessions');

const defaultCamera: CameraState = { yaw: 0.35, pitch: 0.2, distance: 58, target: { x: 0, y: 0, z: 0 } };
const allowedColors = ['#70e6d4', '#9dafff', '#d4a9ff', '#ffbd9e', '#f6dd8e'];
const maxNoteBody = 100_000;

function stringField(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max ? value.trim() : null;
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function oid(value: unknown): ObjectId | null {
  return typeof value === 'string' && ObjectId.isValid(value) ? new ObjectId(value) : null;
}
function number(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : null;
}
function serializeBoard(board: BoardDoc): Board {
  return { id: board._id.toHexString(), title: board.title, cameraState: board.cameraState, updatedAt: board.updatedAt.toISOString() };
}
function serializeNote(note: NoteDoc): Note {
  return { id: note._id.toHexString(), boardId: note.boardId.toHexString(), title: note.title, body: note.body, revision: note.revision, updatedAt: note.updatedAt.toISOString() };
}
function serializeNode(node: NodeDoc, title: string): GraphNode {
  return { id: node._id.toHexString(), noteId: node.noteId.toHexString(), title, x: node.x, y: node.y, z: node.z, scale: node.scale, color: node.color, pinned: node.pinned, revision: node.revision };
}
function serializeEdge(edge: EdgeDoc): GraphEdge {
  return { id: edge._id.toHexString(), sourceNodeId: edge.sourceNodeId.toHexString(), targetNodeId: edge.targetNodeId.toHexString(), kind: edge.kind };
}
function publicUser(user: UserDoc): User {
  return { id: user._id.toHexString(), username: user.username, mustChangePassword: user.mustChangePassword };
}
function cookieOptions() {
  return { path: '/', httpOnly: true, sameSite: 'lax' as const, secure: process.env.NODE_ENV === 'production', maxAge: 60 * 60 * 24 * 7 };
}
async function startSession(user: UserDoc, reply: FastifyReply) {
  const token = randomBytes(32).toString('hex');
  await sessions.insertOne({ _id: new ObjectId(), userId: user._id, tokenHash: createHash('sha256').update(token).digest('hex'), expiresAt: new Date(Date.now() + 7 * 86400_000) });
  reply.setCookie('mp_session', token, cookieOptions());
}
async function sessionUser(request: FastifyRequest): Promise<UserDoc | null> {
  const token = request.cookies.mp_session;
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const session = await sessions.findOne({ tokenHash: createHash('sha256').update(token).digest('hex'), expiresAt: { $gt: new Date() } });
  return session ? users.findOne({ _id: session.userId }) : null;
}
async function requireUser(request: FastifyRequest, reply: FastifyReply, ready = true): Promise<UserDoc | null> {
  const user = await sessionUser(request);
  if (!user) { reply.code(401).send({ error: '로그인이 필요합니다.' }); return null; }
  if (ready && user.mustChangePassword) { reply.code(403).send({ error: '첫 로그인 비밀번호를 변경해 주세요.', code: 'PASSWORD_CHANGE_REQUIRED' }); return null; }
  return user;
}
async function ownedBoard(id: unknown, user: UserDoc, reply: FastifyReply): Promise<BoardDoc | null> {
  const boardId = oid(id);
  const board = boardId ? await boards.findOne({ _id: boardId, ownerId: user._id }) : null;
  if (!board) reply.code(404).send({ error: '보드를 찾을 수 없습니다.' });
  return board;
}
async function ownedNote(id: unknown, user: UserDoc, reply: FastifyReply): Promise<NoteDoc | null> {
  const noteId = oid(id);
  const note = noteId ? await notes.findOne({ _id: noteId }) : null;
  if (!note || !(await boards.findOne({ _id: note.boardId, ownerId: user._id }))) {
    reply.code(404).send({ error: '메모를 찾을 수 없습니다.' }); return null;
  }
  return note;
}
function params(request: FastifyRequest): Record<string, string> { return request.params as Record<string, string>; }
function query(request: FastifyRequest): Record<string, string> { return request.query as Record<string, string>; }

app.addHook('onRequest', async (request, reply) => {
  if (!request.url.startsWith('/api/') || ['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
  const origin = request.headers.origin;
  const allowedHosts = [request.headers.host, process.env.FRONTEND_ORIGIN ? new URL(process.env.FRONTEND_ORIGIN).host : undefined];
  if (origin && !allowedHosts.includes(new URL(origin).host)) {
    reply.code(403).send({ error: '요청 출처가 일치하지 않습니다.' });
  }
});

const loginAttempts = new Map<string, { count: number; until: number }>();
app.post('/api/auth/login', async (request, reply) => {
  const body = object(request.body);
  const username = stringField(body.username, 80);
  const password = typeof body.password === 'string' ? body.password : '';
  const key = `${request.ip}:${username ?? ''}`;
  const previous = loginAttempts.get(key);
  if (previous && previous.until > Date.now() && previous.count >= 5) return reply.code(429).send({ error: '잠시 후 다시 시도해 주세요.' });
  const user = username ? await users.findOne({ username }) : null;
  if (!user || !(await argon2.verify(user.passwordHash, password))) {
    loginAttempts.set(key, { count: (previous?.until && previous.until > Date.now() ? previous.count : 0) + 1, until: Date.now() + 5 * 60_000 });
    return reply.code(401).send({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' });
  }
  loginAttempts.delete(key);
  await startSession(user, reply);
  return { user: publicUser(user) };
});
app.get('/api/auth/me', async (request, reply) => {
  const user = await requireUser(request, reply, false);
  if (user) return { user: publicUser(user) };
});
app.post('/api/auth/logout', async (request, reply) => {
  const token = request.cookies.mp_session;
  if (token) await sessions.deleteOne({ tokenHash: createHash('sha256').update(token).digest('hex') });
  reply.clearCookie('mp_session', { path: '/' });
  return { ok: true };
});
app.patch('/api/auth/password', async (request, reply) => {
  const user = await requireUser(request, reply, false);
  if (!user) return;
  const body = object(request.body);
  if (typeof body.currentPassword !== 'string' || !(await argon2.verify(user.passwordHash, body.currentPassword))) return reply.code(401).send({ error: '현재 비밀번호가 틀렸습니다.' });
  const next = typeof body.newPassword === 'string' ? body.newPassword : '';
  if (next.length < 10 || next.length > 128 || next === body.currentPassword) return reply.code(400).send({ error: '새 비밀번호는 10자 이상이어야 합니다.' });
  await users.updateOne({ _id: user._id }, { $set: { passwordHash: await argon2.hash(next, { type: argon2.argon2id }), mustChangePassword: false } });
  const token = request.cookies.mp_session;
  if (!token) return reply.code(401).send({ error: '로그인이 필요합니다.' });
  const tokenHash = createHash('sha256').update(token).digest('hex');
  await sessions.deleteMany({ userId: user._id, tokenHash: { $ne: tokenHash } });
  return { user: { ...publicUser(user), mustChangePassword: false } };
});

app.get('/api/boards', async (request, reply) => {
  const user = await requireUser(request, reply);
  if (!user) return;
  return { boards: (await boards.find({ ownerId: user._id }).sort({ updatedAt: -1 }).toArray()).map(serializeBoard) };
});
app.post('/api/boards', async (request, reply) => {
  const user = await requireUser(request, reply);
  if (!user) return;
  const title = stringField(object(request.body).title, 100);
  if (!title) return reply.code(400).send({ error: '보드 제목을 입력해 주세요.' });
  const now = new Date();
  const board: BoardDoc = { _id: new ObjectId(), ownerId: user._id, title, cameraState: defaultCamera, revision: 1, createdAt: now, updatedAt: now };
  await boards.insertOne(board);
  return reply.code(201).send({ board: serializeBoard(board) });
});
app.patch('/api/boards/:id/camera', async (request, reply) => {
  const user = await requireUser(request, reply);
  if (!user) return;
  const board = await ownedBoard(params(request).id, user, reply);
  if (!board) return;
  const input = object(request.body);
  const target = object(input.target);
  const yaw = number(input.yaw, -1000, 1000), pitch = number(input.pitch, -1.5, 1.5), distance = number(input.distance, 5, 1000);
  const x = number(target.x, -100_000, 100_000), y = number(target.y, -100_000, 100_000), z = number(target.z, -100_000, 100_000);
  if ([yaw, pitch, distance, x, y, z].some(value => value === null)) return reply.code(400).send({ error: '카메라 값이 올바르지 않습니다.' });
  const cameraState: CameraState = { yaw: yaw!, pitch: pitch!, distance: distance!, target: { x: x!, y: y!, z: z! } };
  await boards.updateOne({ _id: board._id }, { $set: { cameraState, updatedAt: new Date() }, $inc: { revision: 1 } });
  return { cameraState };
});
app.get('/api/boards/:id/graph', async (request, reply) => {
  const user = await requireUser(request, reply);
  if (!user) return;
  const board = await ownedBoard(params(request).id, user, reply);
  if (!board) return;
  const limit = Math.min(2500, Math.max(100, Number(query(request).limit) || 1500));
  const focusId = oid(query(request).focus);
  const offset = Math.max(0, Math.min(100_000, Number(query(request).offset) || 0));
  let nodeDocs: NodeDoc[];
  if (focusId) {
    const ids = new Map<string, ObjectId>([[focusId.toHexString(), focusId]]);
    let frontier = [focusId];
    for (let level = 0; level < Math.min(2, Math.max(1, Number(query(request).depth) || 1)); level++) {
      const connected = await edges.find({ boardId: board._id, $or: [{ sourceNodeId: { $in: frontier } }, { targetNodeId: { $in: frontier } }] }).limit(10_000).toArray();
      frontier = [];
      for (const edge of connected) for (const id of [edge.sourceNodeId, edge.targetNodeId]) {
        if (!ids.has(id.toHexString()) && ids.size < limit) { ids.set(id.toHexString(), id); frontier.push(id); }
      }
    }
    nodeDocs = await nodes.find({ boardId: board._id, _id: { $in: [...ids.values()] } }).toArray();
  } else {
    nodeDocs = await nodes.find({ boardId: board._id }).sort({ updatedAt: -1, _id: 1 }).skip(offset).limit(limit).toArray();
  }
  const totalNodes = await nodes.countDocuments({ boardId: board._id });
  const nodeIds = nodeDocs.map(node => node._id);
  const noteDocs = await notes.find({ _id: { $in: nodeDocs.map(node => node.noteId) } }, { projection: { title: 1 } }).toArray();
  const titleById = new Map(noteDocs.map(note => [note._id.toHexString(), note.title]));
  const edgeDocs = nodeIds.length ? await edges.find({ boardId: board._id, $or: [{ sourceNodeId: { $in: nodeIds } }, { targetNodeId: { $in: nodeIds } }] }).limit(20_000).toArray() : [];
  const graph: Graph = { board: serializeBoard(board), nodes: nodeDocs.map(node => serializeNode(node, titleById.get(node.noteId.toHexString()) ?? '제목 없음')), edges: edgeDocs.map(serializeEdge), hasMore: !focusId && offset + nodeDocs.length < totalNodes, totalNodes };
  return graph;
});

app.post('/api/boards/:id/notes', async (request, reply) => {
  const user = await requireUser(request, reply);
  if (!user) return;
  const board = await ownedBoard(params(request).id, user, reply);
  if (!board) return;
  const input = object(request.body);
  const title = stringField(input.title, 120) ?? '새 메모';
  const position = object(input.position);
  const x = number(position.x, -100_000, 100_000) ?? 0, y = number(position.y, -100_000, 100_000) ?? 0, z = number(position.z, -100_000, 100_000) ?? 0;
  const now = new Date();
  const note: NoteDoc = { _id: new ObjectId(), boardId: board._id, title, body: '', revision: 1, createdAt: now, updatedAt: now };
  const node: NodeDoc = { _id: new ObjectId(), boardId: board._id, noteId: note._id, x, y, z, scale: 1, color: allowedColors[Math.floor(Math.random() * allowedColors.length)], pinned: false, revision: 1, updatedAt: now };
  await notes.insertOne(note);
  try { await nodes.insertOne(node); } catch (error) { await notes.deleteOne({ _id: note._id }); throw error; }
  const near = oid(input.nearNodeId);
  let edge: EdgeDoc | null = null;
  if (near && await nodes.findOne({ _id: near, boardId: board._id })) {
    const [sourceNodeId, targetNodeId] = near.toHexString() < node._id.toHexString() ? [near, node._id] : [node._id, near];
    edge = { _id: new ObjectId(), boardId: board._id, sourceNodeId, targetNodeId, kind: 'related', weight: 1, createdAt: now };
    await edges.insertOne(edge);
  }
  await boards.updateOne({ _id: board._id }, { $set: { updatedAt: now } });
  return reply.code(201).send({ note: serializeNote(note), node: serializeNode(node, note.title), edge: edge ? serializeEdge(edge) : null });
});
app.get('/api/notes/:id', async (request, reply) => {
  const user = await requireUser(request, reply);
  if (!user) return;
  const note = await ownedNote(params(request).id, user, reply);
  if (note) return { note: serializeNote(note) };
});
app.patch('/api/notes/:id', async (request, reply) => {
  const user = await requireUser(request, reply);
  if (!user) return;
  const note = await ownedNote(params(request).id, user, reply);
  if (!note) return;
  const input = object(request.body);
  const title = typeof input.title === 'string' ? stringField(input.title, 120) : note.title;
  const body = typeof input.body === 'string' && input.body.length <= maxNoteBody ? input.body : note.body;
  if (!title || (input.body !== undefined && (typeof input.body !== 'string' || input.body.length > maxNoteBody))) return reply.code(400).send({ error: '메모 내용이 올바르지 않습니다.' });
  const revision = number(input.revision, 1, Number.MAX_SAFE_INTEGER);
  if (revision === null) return reply.code(400).send({ error: '수정 버전이 필요합니다.' });
  const result = await notes.findOneAndUpdate({ _id: note._id, revision }, { $set: { title, body, updatedAt: new Date() }, $inc: { revision: 1 } }, { returnDocument: 'after' });
  if (!result) return reply.code(409).send({ error: '다른 변경 내용이 있습니다.', note: serializeNote((await notes.findOne({ _id: note._id }))!) });
  return { note: serializeNote(result) };
});
app.delete('/api/notes/:id', async (request, reply) => {
  const user = await requireUser(request, reply);
  if (!user) return;
  const note = await ownedNote(params(request).id, user, reply);
  if (!note) return;
  const node = await nodes.findOne({ noteId: note._id });
  if (node) await edges.deleteMany({ boardId: note.boardId, $or: [{ sourceNodeId: node._id }, { targetNodeId: node._id }] });
  await nodes.deleteOne({ noteId: note._id });
  await notes.deleteOne({ _id: note._id });
  return { ok: true };
});
app.patch('/api/boards/:id/nodes/:nodeId', async (request, reply) => {
  const user = await requireUser(request, reply);
  if (!user) return;
  const board = await ownedBoard(params(request).id, user, reply);
  if (!board) return;
  const nodeId = oid(params(request).nodeId);
  const input = object(request.body);
  const x = number(input.x, -100_000, 100_000), y = number(input.y, -100_000, 100_000), z = number(input.z, -100_000, 100_000);
  const scale = number(input.scale, 0.5, 3), revision = number(input.revision, 1, Number.MAX_SAFE_INTEGER);
  if (!nodeId || [x, y, z, scale, revision].some(value => value === null)) return reply.code(400).send({ error: '노드 값이 올바르지 않습니다.' });
  const result = await nodes.findOneAndUpdate({ _id: nodeId, boardId: board._id, revision: revision! }, { $set: { x: x!, y: y!, z: z!, scale: scale!, pinned: true, updatedAt: new Date() }, $inc: { revision: 1 } }, { returnDocument: 'after' });
  if (!result) return reply.code(409).send({ error: '노드가 수정되었거나 없습니다.' });
  return { node: serializeNode(result, '') };
});
app.post('/api/boards/:id/edges', async (request, reply) => {
  const user = await requireUser(request, reply);
  if (!user) return;
  const board = await ownedBoard(params(request).id, user, reply);
  if (!board) return;
  const input = object(request.body);
  const source = oid(input.sourceNodeId), target = oid(input.targetNodeId);
  if (!source || !target || source.equals(target)) return reply.code(400).send({ error: '연결할 노드를 선택해 주세요.' });
  const existingNodes = await nodes.countDocuments({ boardId: board._id, _id: { $in: [source, target] } });
  if (existingNodes !== 2) return reply.code(404).send({ error: '노드를 찾을 수 없습니다.' });
  const [first, second] = source.toHexString() < target.toHexString() ? [source, target] : [target, source];
  const edge: EdgeDoc = { _id: new ObjectId(), boardId: board._id, sourceNodeId: first, targetNodeId: second, kind: 'related', weight: 1, createdAt: new Date() };
  try { await edges.insertOne(edge); } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 11000) {
      const found = await edges.findOne({ boardId: board._id, sourceNodeId: first, targetNodeId: second });
      return { edge: serializeEdge(found!) };
    }
    throw error;
  }
  return reply.code(201).send({ edge: serializeEdge(edge) });
});
app.delete('/api/boards/:id/edges/:edgeId', async (request, reply) => {
  const user = await requireUser(request, reply);
  if (!user) return;
  const board = await ownedBoard(params(request).id, user, reply);
  if (!board) return;
  const edgeId = oid(params(request).edgeId);
  if (!edgeId) return reply.code(400).send({ error: '연결 ID가 올바르지 않습니다.' });
  await edges.deleteOne({ _id: edgeId, boardId: board._id });
  return { ok: true };
});
app.get('/api/boards/:id/search', async (request, reply) => {
  const user = await requireUser(request, reply);
  if (!user) return;
  const board = await ownedBoard(params(request).id, user, reply);
  if (!board) return;
  const term = stringField(query(request).q, 80);
  if (!term) return { results: [] };
  const safe = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const found = await notes.find({ boardId: board._id, title: { $regex: safe, $options: 'i' } }, { projection: { title: 1 } }).limit(20).toArray();
  const foundNodes = await nodes.find({ boardId: board._id, noteId: { $in: found.map(note => note._id) } }).toArray();
  const byNote = new Map(foundNodes.map(node => [node.noteId.toHexString(), node]));
  return { results: found.map(note => ({ noteId: note._id.toHexString(), nodeId: byNote.get(note._id.toHexString())?._id.toHexString(), title: note.title })) };
});
app.get('/api/boards/:id/export', async (request, reply) => {
  const user = await requireUser(request, reply);
  if (!user) return;
  const board = await ownedBoard(params(request).id, user, reply);
  if (!board) return;
  const [allNotes, allNodes, allEdges] = await Promise.all([
    notes.find({ boardId: board._id }).toArray(), nodes.find({ boardId: board._id }).toArray(), edges.find({ boardId: board._id }).toArray(),
  ]);
  reply.header('Content-Disposition', `attachment; filename="memoryplace-${board._id.toHexString()}.json"`);
  return { version: 1, board: serializeBoard(board), notes: allNotes.map(serializeNote), nodes: allNodes.map(node => serializeNode(node, allNotes.find(note => note._id.equals(node.noteId))?.title ?? '')), edges: allEdges.map(serializeEdge) };
});

app.get('/api/health', async () => ({ ok: (await db.command({ ping: 1 })).ok === 1 }));

const dist = resolve(process.cwd(), 'dist');
if (existsSync(dist)) await app.register(fastifyStatic, { root: dist, prefix: '/' });

async function prepareDatabase(database: Db) {
  await Promise.all([
    users.createIndex({ username: 1 }, { unique: true }),
    boards.createIndex({ ownerId: 1, updatedAt: -1 }),
    notes.createIndex({ boardId: 1, updatedAt: -1 }),
    nodes.createIndex({ boardId: 1, updatedAt: -1 }),
    nodes.createIndex({ noteId: 1 }, { unique: true }),
    edges.createIndex({ boardId: 1, sourceNodeId: 1, targetNodeId: 1 }, { unique: true }),
    edges.createIndex({ boardId: 1, targetNodeId: 1 }),
    sessions.createIndex({ tokenHash: 1 }, { unique: true }),
    sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
  ]);
  if (!await users.findOne({ username: 'admin' })) {
    const now = new Date();
    const admin: UserDoc = { _id: new ObjectId(), username: 'admin', passwordHash: await argon2.hash('1234', { type: argon2.argon2id }), role: 'admin', mustChangePassword: true, createdAt: now };
    try { await users.insertOne(admin); } catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 11000)) throw error; }
    if (await users.findOne({ _id: admin._id })) {
      const board: BoardDoc = { _id: new ObjectId(), ownerId: admin._id, title: '나의 공간', cameraState: defaultCamera, revision: 1, createdAt: now, updatedAt: now };
      await boards.insertOne(board);
      const samples = [
        { title: '첫 번째 생각', body: '이 공간에서 떠오르는 생각을 자유롭게 기록해 보세요.', position: { x: 0, y: 0, z: 0 }, color: '#70e6d4' },
        { title: '새로운 아이디어', body: '노드를 선택하고 드래그해 위치를 바꿀 수 있습니다.', position: { x: 13, y: 8, z: -3 }, color: '#9dafff' },
        { title: '기억할 것', body: '두 생각을 연결하면 나만의 지도가 만들어집니다.', position: { x: -12, y: 6, z: -6 }, color: '#d4a9ff' },
        { title: '오늘의 메모', body: '페이지 모드에서 긴 글을 써 보세요.', position: { x: 4, y: -12, z: 4 }, color: '#ffbd9e' },
      ];
      const createdNodes: NodeDoc[] = [];
      for (const sample of samples) {
        const note: NoteDoc = { _id: new ObjectId(), boardId: board._id, title: sample.title, body: sample.body, revision: 1, createdAt: now, updatedAt: now };
        const node: NodeDoc = { _id: new ObjectId(), boardId: board._id, noteId: note._id, ...sample.position, scale: 1, color: sample.color, pinned: true, revision: 1, updatedAt: now };
        await notes.insertOne(note); await nodes.insertOne(node); createdNodes.push(node);
      }
      await edges.insertMany(createdNodes.slice(1).map(node => ({ _id: new ObjectId(), boardId: board._id, sourceNodeId: createdNodes[0]._id, targetNodeId: node._id, kind: 'related', weight: 1, createdAt: now })));
    }
  }
  app.log.info(`MongoDB ready: ${database.databaseName}`);
}

await prepareDatabase(db);
const port = Number(process.env.PORT) || 3001;
const host = process.env.HOST || '127.0.0.1';
await app.listen({ port, host });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => { await app.close(); await client.close(); process.exit(0); });
}
