import type { GraphEdge, GraphNode, Vec3 } from '../shared/types';

type Request = { nodes: GraphNode[]; edges: GraphEdge[]; movingId: string };
type Response = { id: string; position: Vec3 };

self.onmessage = (event: MessageEvent<Request>) => {
  const { nodes, edges, movingId } = event.data;
  const moving = nodes.find(node => node.id === movingId);
  if (!moving) return;
  const adjacent = edges.filter(edge => edge.sourceNodeId === movingId || edge.targetNodeId === movingId);
  const neighbors = adjacent.map(edge => nodes.find(node => node.id === (edge.sourceNodeId === movingId ? edge.targetNodeId : edge.sourceNodeId))).filter((node): node is GraphNode => Boolean(node));
  let x = moving.x, y = moving.y, z = moving.z;
  for (let tick = 0; tick < 48; tick++) {
    let fx = 0, fy = 0, fz = 0;
    for (const neighbor of neighbors) {
      const dx = neighbor.x - x, dy = neighbor.y - y, dz = neighbor.z - z;
      const distance = Math.max(0.1, Math.hypot(dx, dy, dz));
      const spring = (distance - 16) * 0.012;
      fx += dx / distance * spring; fy += dy / distance * spring; fz += dz / distance * spring;
    }
    for (const other of nodes) {
      if (other.id === movingId) continue;
      const dx = x - other.x, dy = y - other.y, dz = z - other.z;
      const distance2 = dx * dx + dy * dy + dz * dz + 0.5;
      if (distance2 > 800) continue;
      const repulsion = Math.min(0.24, 6 / distance2);
      fx += dx * repulsion; fy += dy * repulsion; fz += dz * repulsion;
    }
    x += Math.max(-0.7, Math.min(0.7, fx));
    y += Math.max(-0.7, Math.min(0.7, fy));
    z += Math.max(-0.7, Math.min(0.7, fz));
  }
  self.postMessage({ id: movingId, position: { x, y, z } } satisfies Response);
};
