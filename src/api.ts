import type { Board, Graph, GraphEdge, GraphNode, Note, User } from '../shared/types';

export class ApiError extends Error {
  constructor(message: string, public status: number, public data: Record<string, unknown>) { super(message); }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      credentials: 'same-origin',
      headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
      ...options,
    });
  } catch {
    throw new ApiError('서버에 연결할 수 없습니다. 연결을 확인해 주세요.', 0, {});
  }
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new ApiError(String(data.error ?? '요청을 처리하지 못했습니다.'), response.status, data);
  return data as T;
}

export const authApi = {
  me: () => api<{ user: User }>('/auth/me'),
  login: (username: string, password: string) => api<{ user: User }>('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  logout: () => api<{ ok: true }>('/auth/logout', { method: 'POST' }),
  password: (currentPassword: string, newPassword: string) => api<{ user: User }>('/auth/password', { method: 'PATCH', body: JSON.stringify({ currentPassword, newPassword }) }),
};

export const boardApi = {
  list: () => api<{ boards: Board[] }>('/boards'),
  create: (title: string) => api<{ board: Board }>('/boards', { method: 'POST', body: JSON.stringify({ title }) }),
  graph: (boardId: string, options: { offset?: number; focus?: string; depth?: number } = {}) => {
    const query = new URLSearchParams();
    if (options.offset) query.set('offset', String(options.offset));
    if (options.focus) query.set('focus', options.focus);
    if (options.depth) query.set('depth', String(options.depth));
    return api<Graph>(`/boards/${boardId}/graph?${query}`);
  },
  camera: (boardId: string, cameraState: Board['cameraState']) => api<{ cameraState: Board['cameraState'] }>(`/boards/${boardId}/camera`, { method: 'PATCH', body: JSON.stringify(cameraState) }),
  search: (boardId: string, q: string) => api<{ results: { noteId: string; nodeId?: string; title: string }[] }>(`/boards/${boardId}/search?q=${encodeURIComponent(q)}`),
  createNote: (boardId: string, title: string, position: { x: number; y: number; z: number }, nearNodeId?: string) => api<{ note: Note; node: GraphNode; edge: GraphEdge | null }>(`/boards/${boardId}/notes`, { method: 'POST', body: JSON.stringify({ title, position, nearNodeId }) }),
  moveNode: (boardId: string, node: GraphNode) => api<{ node: GraphNode }>(`/boards/${boardId}/nodes/${node.id}`, { method: 'PATCH', body: JSON.stringify({ x: node.x, y: node.y, z: node.z, scale: node.scale, revision: node.revision }) }),
  link: (boardId: string, sourceNodeId: string, targetNodeId: string) => api<{ edge: GraphEdge }>(`/boards/${boardId}/edges`, { method: 'POST', body: JSON.stringify({ sourceNodeId, targetNodeId }) }),
  unlink: (boardId: string, edgeId: string) => api<{ ok: true }>(`/boards/${boardId}/edges/${edgeId}`, { method: 'DELETE' }),
};

export const noteApi = {
  get: (noteId: string) => api<{ note: Note }>(`/notes/${noteId}`),
  save: (note: Note) => api<{ note: Note }>(`/notes/${note.id}`, { method: 'PATCH', body: JSON.stringify({ title: note.title, body: note.body, revision: note.revision }) }),
  delete: (noteId: string) => api<{ ok: true }>(`/notes/${noteId}`, { method: 'DELETE' }),
};
