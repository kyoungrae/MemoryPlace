import { MongoClient, ObjectId } from 'mongodb';

const mongoUrl = process.env.MONGO_URL;
const dbName = process.env.MONGO_DB_NAME;
if (!mongoUrl || !dbName || !/^memoryplace_(integration|benchmark|test)/.test(dbName)) {
  throw new Error('Use MONGO_URL and a disposable MONGO_DB_NAME beginning with memoryplace_integration, memoryplace_benchmark or memoryplace_test.');
}

const count = Math.min(10_000, Math.max(1000, Number(process.env.BENCHMARK_NODES) || 5000));
const client = new MongoClient(mongoUrl);
await client.connect();
const db = client.db(dbName);
const admin = await db.collection('users').findOne({ username: 'admin' });
if (!admin) throw new Error('Start the API once to seed the admin account before adding a benchmark board.');
const now = new Date();
const boardId = new ObjectId();
await db.collection('boards').insertOne({ _id: boardId, ownerId: admin._id, title: `성능 테스트 ${count.toLocaleString()}개`, cameraState: { yaw: 0.35, pitch: 0.2, distance: 220, target: { x: 0, y: 0, z: 0 } }, revision: 1, createdAt: now, updatedAt: now });
const notes = [], nodes = [];
const palette = ['#70e6d4', '#9dafff', '#d4a9ff', '#ffbd9e', '#f6dd8e'];
for (let index = 0; index < count; index++) {
  const noteId = new ObjectId(), nodeId = new ObjectId();
  const angle = index * 2.399963229728653;
  const unitY = 1 - 2 * (index + 0.5) / count;
  const radius = Math.sqrt(1 - unitY * unitY);
  const outer = 55 + (index % 29) * 1.35;
  notes.push({ _id: noteId, boardId, title: `성능 노드 ${String(index + 1).padStart(5, '0')}`, body: '', revision: 1, createdAt: now, updatedAt: now });
  nodes.push({ _id: nodeId, boardId, noteId, x: Math.cos(angle) * radius * outer, y: unitY * outer, z: Math.sin(angle) * radius * outer, scale: 0.8 + (index % 4) * 0.1, color: palette[index % palette.length], pinned: true, revision: 1, updatedAt: now });
}
for (let offset = 0; offset < count; offset += 1000) {
  await db.collection('notes').insertMany(notes.slice(offset, offset + 1000));
  await db.collection('nodes').insertMany(nodes.slice(offset, offset + 1000));
}
const edges = [];
const seen = new Set<string>();
for (let index = 1; index < count; index++) {
  for (const neighbor of [Math.floor(index / 2), (index + 37) % count]) {
    if (index === neighbor) continue;
    const pair = [index, neighbor].sort((a, b) => a - b);
    const key = pair.join(':');
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ _id: new ObjectId(), boardId, sourceNodeId: nodes[pair[0]]._id, targetNodeId: nodes[pair[1]]._id, kind: 'related', weight: 1, createdAt: now });
  }
}
for (let offset = 0; offset < edges.length; offset += 1000) await db.collection('edges').insertMany(edges.slice(offset, offset + 1000));
console.log(`Created benchmark board ${boardId.toHexString()} with ${nodes.length} nodes and ${edges.length} edges in ${dbName}`);
await client.close();
