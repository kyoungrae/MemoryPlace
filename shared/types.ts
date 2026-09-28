export type Vec3 = { x: number; y: number; z: number };
export type CameraState = { yaw: number; pitch: number; distance: number; target: Vec3 };

export type User = {
  id: string;
  username: string;
  mustChangePassword: boolean;
};

export type Board = {
  id: string;
  title: string;
  cameraState: CameraState;
  updatedAt: string;
};

export type GraphNode = Vec3 & {
  id: string;
  noteId: string;
  title: string;
  scale: number;
  color: string;
  pinned: boolean;
  revision: number;
};

export type GraphEdge = {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  kind: string;
};

export type Graph = {
  board: Board;
  nodes: GraphNode[];
  edges: GraphEdge[];
  hasMore: boolean;
  totalNodes: number;
};

export type Note = {
  id: string;
  boardId: string;
  title: string;
  body: string;
  revision: number;
  updatedAt: string;
};
