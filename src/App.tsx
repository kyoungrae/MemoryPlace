import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Board, CameraState, Graph, GraphEdge, GraphNode, Note, User } from '../shared/types';
import { ApiError, authApi, boardApi, noteApi } from './api';

const NeuronCanvas = lazy(() => import('./NeuronCanvas').then(module => ({ default: module.NeuronCanvas })));

type SaveStatus = 'saved' | 'dirty' | 'saving' | 'offline' | 'conflict';
type SearchResult = { noteId: string; nodeId?: string; title: string };
type Anchor = { x: number; y: number };
type PanelState = { nodeId: string; anchor: Anchor; phase: 'opening' | 'open' | 'closing' };

const statusLabel: Record<SaveStatus, string> = { saved: '모든 변경사항 저장됨', dirty: '저장 대기 중', saving: '저장 중…', offline: '연결 대기 중 · 기기에 임시 보관', conflict: '다른 변경 내용과 충돌' };

function Logo({ small = false }: { small?: boolean }) {
  return <div className={`brand ${small ? 'brand-small' : ''}`}><div className="brand-mark"><span /><span /><span /><span /></div><div><strong>MemoryPlace</strong>{!small && <small>생각이 이어지는 공간</small>}</div></div>;
}

function AuthScreen({ onLogin }: { onLogin: (user: User) => void }) {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try { onLogin((await authApi.login(username, password)).user); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '로그인에 실패했습니다.'); }
    finally { setBusy(false); }
  };
  return <main className="auth-screen">
    <div className="auth-orbit orbit-one" /><div className="auth-orbit orbit-two" /><div className="auth-orbit orbit-three" />
    <div className="auth-intro"><Logo /><div className="eyebrow">YOUR PERSONAL KNOWLEDGE UNIVERSE</div><h1>생각의 조각들이<br /><em>하나의 우주</em>가 되는 곳.</h1><p>메모를 남기고, 이어 붙이고, 새로운 시각에서 탐색하세요.<br />평범한 기록이 살아 있는 지도가 됩니다.</p><div className="auth-preview"><div className="preview-lines"><i /><i /><i /><i /><i /><i /></div><span>당신의 생각을 3D 공간에서 만나보세요</span></div></div>
    <form className="auth-card" onSubmit={submit}><div className="card-icon">✦</div><h2>다시 만나서 반가워요</h2><p>나만의 공간으로 들어가세요.</p><label>아이디<input autoComplete="username" value={username} onChange={event => setUsername(event.target.value)} required /></label><label>비밀번호<input type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} required placeholder="비밀번호 입력" /></label>{error && <div className="form-error" role="alert">{error}</div>}<button className="primary-button auth-submit" disabled={busy}>{busy ? '연결 중…' : '공간으로 들어가기'} <span>→</span></button><div className="auth-hint">처음 로그인: admin / 1234 · 로그인 후 비밀번호 변경</div></form>
  </main>;
}

function PasswordScreen({ onDone }: { onDone: (user: User) => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (next !== confirm) { setError('새 비밀번호가 일치하지 않습니다.'); return; }
    setBusy(true); setError('');
    try { onDone((await authApi.password(current, next)).user); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '비밀번호를 변경하지 못했습니다.'); }
    finally { setBusy(false); }
  };
  return <main className="auth-screen password-screen"><div className="auth-intro"><Logo /><div className="eyebrow">A SAFER SPACE FOR YOUR THOUGHTS</div><h1>기록을 시작하기 전에<br /><em>비밀번호를 바꿔주세요.</em></h1><p>처음 로그인에 사용한 비밀번호는 모두에게 알려져 있습니다.<br />새 비밀번호를 설정하면 메모 공간이 열립니다.</p></div><form className="auth-card" onSubmit={submit}><div className="card-icon">◈</div><h2>비밀번호 변경</h2><p>10자 이상의 새 비밀번호를 사용해 주세요.</p><label>현재 비밀번호<input type="password" autoComplete="current-password" value={current} onChange={event => setCurrent(event.target.value)} required /></label><label>새 비밀번호<input type="password" autoComplete="new-password" value={next} onChange={event => setNext(event.target.value)} minLength={10} required /></label><label>새 비밀번호 확인<input type="password" autoComplete="new-password" value={confirm} onChange={event => setConfirm(event.target.value)} required /></label>{error && <div className="form-error" role="alert">{error}</div>}<button className="primary-button auth-submit" disabled={busy}>{busy ? '변경 중…' : '변경하고 시작하기'} <span>→</span></button></form></main>;
}

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [booting, setBooting] = useState(true);
  const [boards, setBoards] = useState<Board[]>([]);
  const [boardId, setBoardId] = useState<string | null>(null);
  const [graph, setGraph] = useState<Graph | null>(null);
  const graphRef = useRef<Graph | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [panel, setPanel] = useState<PanelState | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  const noteRef = useRef<Note | null>(null);
  const [mode, setMode] = useState<'neuron' | 'page'>('neuron');
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('saved');
  const [linking, setLinking] = useState(false);
  const [search, setSearch] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [error, setError] = useState('');
  const [loadingGraph, setLoadingGraph] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectedBoardIds, setSelectedBoardIds] = useState<Set<string>>(() => new Set());
  const [selectedNoteIds, setSelectedNoteIds] = useState<Set<string>>(() => new Set());
  const [allNotesSelected, setAllNotesSelected] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState<'boards' | 'notes' | null>(null);
  const [command, setCommand] = useState<{ id: number; type: 'fit' | 'focus' | 'in' | 'out'; nodeId?: string } | null>(null);
  const [metrics, setMetrics] = useState({ frameP95: 0, drawCalls: 0, visibleNodes: 0 });
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cameraTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scaleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const saving = useRef(false);
  const noteRequest = useRef(0);
  const pendingMoves = useRef(new Map<string, GraphNode>());
  const activeMoves = useRef(new Set<string>());
  const pendingLinks = useRef(new Set<string>());
  const workerRef = useRef<Worker | null>(null);

  useEffect(() => { graphRef.current = graph; }, [graph]);
  useEffect(() => { noteRef.current = note; }, [note]);
  useLayoutEffect(() => {
    if (!panel || !panelRef.current) return;
    const element = panelRef.current;
    const parentRect = element.offsetParent?.getBoundingClientRect();
    if (!parentRect) return;
    const dx = panel.anchor.x - parentRect.left - element.offsetLeft - element.offsetWidth / 2;
    const dy = panel.anchor.y - parentRect.top - element.offsetTop - element.offsetHeight / 2;
    element.style.setProperty('--genie-x', `${dx}px`);
    element.style.setProperty('--genie-y', `${dy}px`);
  }, [panel]);
  useEffect(() => {
    if (!panel || panel.phase === 'open') return;
    const { nodeId, phase } = panel;
    const timer = setTimeout(() => {
      if (phase === 'opening') {
        setPanel(current => current?.nodeId === nodeId && current.phase === 'opening' ? { ...current, phase: 'open' } : current);
      } else {
        setPanel(current => current?.nodeId === nodeId && current.phase === 'closing' ? null : current);
        setSelectedId(current => current === nodeId ? null : current);
      }
    }, phase === 'opening' ? 500 : 460);
    return () => clearTimeout(timer);
  }, [panel?.nodeId, panel?.phase]);
  useEffect(() => { authApi.me().then(result => setUser(result.user)).catch(() => {}).finally(() => setBooting(false)); }, []);
  useEffect(() => {
    const worker = new Worker(new URL('./layout.worker.ts', import.meta.url), { type: 'module' });
    workerRef.current = worker;
    return () => worker.terminate();
  }, []);
  useEffect(() => {
    if (!user || user.mustChangePassword) return;
    boardApi.list().then(result => {
      setBoards(result.boards);
      const remembered = localStorage.getItem('memoryplace:board');
      setBoardId(result.boards.find(board => board.id === remembered)?.id ?? result.boards[0]?.id ?? null);
    }).catch(cause => setError(cause instanceof Error ? cause.message : '보드를 불러오지 못했습니다.'));
  }, [user]);
  useEffect(() => {
    if (!boardId || !user || user.mustChangePassword) return;
    let cancelled = false;
    if (noteRef.current) {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      void saveDraft();
      noteRef.current = null;
    }
    setGraph(null); setSelectedId(null); setPanel(null); setNote(null); setMode('neuron'); setSelectedNoteIds(new Set()); setAllNotesSelected(false); setLoadingGraph(true);
    localStorage.setItem('memoryplace:board', boardId);
    boardApi.graph(boardId).then(result => { if (!cancelled) setGraph(result); }).catch(cause => { if (!cancelled) setError(cause instanceof Error ? cause.message : '그래프를 불러오지 못했습니다.'); }).finally(() => { if (!cancelled) setLoadingGraph(false); });
    return () => { cancelled = true; };
  }, [boardId, user]);
  useEffect(() => {
    if (!boardId || search.trim().length < 1) { setSearchResults([]); return; }
    const timer = setTimeout(() => boardApi.search(boardId, search.trim()).then(result => setSearchResults(result.results)).catch(() => setSearchResults([])), 220);
    return () => clearTimeout(timer);
  }, [boardId, search]);
  useEffect(() => {
    const online = () => { if (saveStatus === 'offline') void saveDraft(); };
    window.addEventListener('online', online);
    return () => window.removeEventListener('online', online);
  });

  const saveDraft = useCallback(async () => {
    const snapshot = noteRef.current;
    if (!snapshot) return;
    if (!snapshot.title.trim()) { setSaveStatus('dirty'); return; }
    if (saving.current) {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => void saveDraft(), 500);
      return;
    }
    saving.current = true; setSaveStatus('saving');
    try {
      const result = await noteApi.save(snapshot);
      const current = noteRef.current;
      if (current?.id === snapshot.id) {
        const changedSince = current.title !== snapshot.title || current.body !== snapshot.body;
        const next = { ...current, revision: result.note.revision, updatedAt: result.note.updatedAt };
        noteRef.current = next; setNote(next);
        setSaveStatus(changedSince ? 'dirty' : 'saved');
        if (changedSince) {
          if (saveTimer.current) clearTimeout(saveTimer.current);
          saveTimer.current = setTimeout(() => void saveDraft(), 500);
        } else localStorage.removeItem(`memoryplace:draft:${snapshot.id}`);
        setGraph(previous => previous ? { ...previous, nodes: previous.nodes.map(node => node.noteId === snapshot.id ? { ...node, title: changedSince ? current.title : result.note.title } : node) } : previous);
      } else localStorage.removeItem(`memoryplace:draft:${snapshot.id}`);
    } catch (cause) {
      if (noteRef.current?.id === snapshot.id) {
        setSaveStatus(cause instanceof ApiError && cause.status === 409 ? 'conflict' : 'offline');
        if (!(cause instanceof ApiError && cause.status === 409)) setError('연결이 복구되면 메모 저장을 다시 시도합니다.');
      }
    } finally { saving.current = false; }
  }, []);

  const updateDraft = (patch: Partial<Pick<Note, 'title' | 'body'>>) => {
    const current = noteRef.current;
    if (!current) return;
    const next = { ...current, ...patch };
    noteRef.current = next; setNote(next); setSaveStatus('dirty');
    if (patch.title !== undefined) setGraph(previous => previous ? { ...previous, nodes: previous.nodes.map(node => node.noteId === next.id ? { ...node, title: next.title || '제목 없음' } : node) } : previous);
    localStorage.setItem(`memoryplace:draft:${next.id}`, JSON.stringify({ title: next.title, body: next.body }));
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void saveDraft(), 650);
  };

  const loadNote = async (noteId: string) => {
    if (noteRef.current?.id === noteId) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    if (saveStatus === 'dirty' || saveStatus === 'offline') void saveDraft();
    const requestId = ++noteRequest.current;
    setNote(null);
    try {
      const result = await noteApi.get(noteId);
      if (requestId !== noteRequest.current) return;
      let loaded = result.note;
      const backup = localStorage.getItem(`memoryplace:draft:${noteId}`);
      if (backup) {
        try { const draft = JSON.parse(backup) as { title: string; body: string }; loaded = { ...loaded, title: draft.title, body: draft.body }; setSaveStatus('dirty'); }
        catch { localStorage.removeItem(`memoryplace:draft:${noteId}`); setSaveStatus('saved'); }
      } else setSaveStatus('saved');
      noteRef.current = loaded; setNote(loaded);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '메모를 열 수 없습니다.'); }
  };

  const mergeGraph = (part: Graph) => setGraph(previous => {
    if (!previous) return part;
    const nodes = new Map(previous.nodes.map(node => [node.id, node]));
    const edges = new Map(previous.edges.map(edge => [edge.id, edge]));
    part.nodes.forEach(node => nodes.set(node.id, node));
    part.edges.forEach(edge => edges.set(edge.id, edge));
    return { ...previous, nodes: [...nodes.values()], edges: [...edges.values()], hasMore: part.hasMore, totalNodes: part.totalNodes };
  });

  const showPanel = (nodeId: string, anchor?: Anchor) => {
    setPanel(current => mode !== 'neuron' ? null : anchor ? { nodeId, anchor, phase: 'opening' } : current?.nodeId === nodeId ? { ...current, phase: current.phase === 'closing' ? 'opening' : current.phase } : null);
  };
  const updatePanelAnchor = (nodeId: string, anchor: Anchor) => {
    if (mode !== 'neuron' || selectedId !== nodeId) return;
    setPanel(current => current?.phase === 'closing' ? current : current?.nodeId === nodeId ? { ...current, anchor } : { nodeId, anchor, phase: 'opening' });
  };
  const dismissPanel = (anchor?: Anchor | null) => {
    if (!selectedId && !panel) return;
    setLinking(false);
    if (!panel) { setSelectedId(null); return; }
    setPanel(current => current ? { ...current, anchor: anchor ?? current.anchor, phase: 'closing' } : null);
  };

  const linkNodes = async (sourceNodeId: string, targetNodeId: string) => {
    const current = graphRef.current;
    if (!current || !boardId) return;
    if (sourceNodeId === targetNodeId) return;
    const linkKey = [sourceNodeId, targetNodeId].sort().join(':');
    const connected = current.edges.some(edge => edge.sourceNodeId === sourceNodeId && edge.targetNodeId === targetNodeId || edge.sourceNodeId === targetNodeId && edge.targetNodeId === sourceNodeId);
    if (pendingLinks.current.has(linkKey)) return;
    if (connected) { setError('이미 연결된 생각입니다.'); return; }
    pendingLinks.current.add(linkKey);
    const pending: GraphEdge = { id: `pending:${crypto.randomUUID()}`, sourceNodeId, targetNodeId, kind: 'related' };
    setGraph(previous => previous ? { ...previous, edges: [...previous.edges, pending] } : previous);
    try {
      const { edge } = await boardApi.link(boardId, sourceNodeId, targetNodeId);
      setGraph(previous => previous ? { ...previous, edges: [...previous.edges.filter(item => item.id !== pending.id && item.id !== edge.id), edge] } : previous);
    } catch (cause) {
      setGraph(previous => previous ? { ...previous, edges: previous.edges.filter(item => item.id !== pending.id) } : previous);
      setError(cause instanceof Error ? cause.message : '연결을 만들지 못했습니다.');
    } finally {
      pendingLinks.current.delete(linkKey);
    }
  };

  const selectNode = async (nodeId: string, open = false, anchor?: Anchor) => {
    const current = graphRef.current;
    if (!current || !boardId) return;
    if (linking && selectedId && selectedId !== nodeId) {
      setLinking(false);
      await linkNodes(selectedId, nodeId);
      return;
    }
    let node = current.nodes.find(item => item.id === nodeId);
    if (!node) {
      try {
        const part = await boardApi.graph(boardId, { focus: nodeId, depth: 1 });
        mergeGraph(part);
        node = part.nodes.find(item => item.id === nodeId);
      } catch (cause) { setError(cause instanceof Error ? cause.message : '연결된 생각을 불러오지 못했습니다.'); }
    }
    if (!node) return;
    if (open) { setPanel(null); setMode('page'); }
    else showPanel(nodeId, anchor);
    setSelectedId(nodeId); setSidebarOpen(false);
    await loadNote(node.noteId);
  };

  const flushMove = async (nodeId: string) => {
    if (activeMoves.current.has(nodeId)) return;
    const node = pendingMoves.current.get(nodeId);
    if (!node || !boardId) return;
    pendingMoves.current.delete(nodeId); activeMoves.current.add(nodeId);
    try {
      const result = await boardApi.moveNode(boardId, node);
      setGraph(previous => previous ? { ...previous, nodes: previous.nodes.map(item => item.id === nodeId ? { ...item, revision: result.node.revision } : item) } : previous);
      const pending = pendingMoves.current.get(nodeId);
      if (pending) pending.revision = result.node.revision;
    } catch (cause) {
      if (!(cause instanceof ApiError && cause.status === 404)) setError(cause instanceof Error ? cause.message : '노드 위치를 저장하지 못했습니다.');
    }
    finally { activeMoves.current.delete(nodeId); if (pendingMoves.current.has(nodeId)) void flushMove(nodeId); }
  };
  const commitNode = (node: GraphNode) => {
    setGraph(previous => previous ? { ...previous, nodes: previous.nodes.map(item => item.id === node.id ? { ...item, x: node.x, y: node.y, z: node.z, scale: node.scale } : item) } : previous);
    pendingMoves.current.set(node.id, node);
    void flushMove(node.id);
  };
  const onCamera = (cameraState: CameraState) => {
    if (!boardId) return;
    setGraph(previous => previous ? { ...previous, board: { ...previous.board, cameraState } } : previous);
    if (cameraTimer.current) clearTimeout(cameraTimer.current);
    cameraTimer.current = setTimeout(() => { void boardApi.camera(boardId, cameraState).catch(() => {}); }, 900);
  };

  const createNote = async () => {
    if (!boardId || !graph) return;
    const near = graph.nodes.find(node => node.id === selectedId);
    const angle = Math.random() * Math.PI * 2;
    const position = near ? { x: near.x + Math.cos(angle) * 15, y: near.y + Math.sin(angle) * 12, z: near.z + (Math.random() - 0.5) * 8 } : { x: 0, y: 0, z: 0 };
    try {
      if (noteRef.current && (saveStatus === 'dirty' || saveStatus === 'offline')) void saveDraft();
      const result = await boardApi.createNote(boardId, '새 메모', position, near?.id);
      setGraph(previous => previous ? { ...previous, nodes: [result.node, ...previous.nodes], edges: result.edge ? [...previous.edges, result.edge] : previous.edges, totalNodes: previous.totalNodes + 1 } : previous);
      showPanel(result.node.id);
      setSelectedId(result.node.id); noteRef.current = result.note; setNote(result.note); setSaveStatus('saved'); setMode('neuron'); setLinking(false); setSidebarOpen(false);
      if (workerRef.current) {
        workerRef.current.onmessage = (event: MessageEvent<{ id: string; position: { x: number; y: number; z: number } }>) => {
          if (event.data.id === result.node.id) commitNode({ ...result.node, ...event.data.position });
        };
        workerRef.current.postMessage({ nodes: [...graph.nodes, result.node], edges: result.edge ? [...graph.edges, result.edge] : graph.edges, movingId: result.node.id });
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : '메모를 만들지 못했습니다.'); }
  };

  const openSearchResult = async (result: SearchResult) => {
    if (!boardId) return;
    if (result.nodeId && !graphRef.current?.nodes.some(node => node.id === result.nodeId)) {
      try { mergeGraph(await boardApi.graph(boardId, { focus: result.nodeId, depth: 2 })); }
      catch (cause) { setError(cause instanceof Error ? cause.message : '검색 결과를 불러오지 못했습니다.'); return; }
    }
    if (result.nodeId) { showPanel(result.nodeId); setSelectedId(result.nodeId); setCommand({ id: Date.now(), type: 'focus', nodeId: result.nodeId }); }
    await loadNote(result.noteId);
    setSearch(''); setSidebarOpen(false);
  };

  const toggleBoardSelection = (id: string) => setSelectedBoardIds(current => {
    const next = new Set(current);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });
  const toggleNoteSelection = (id: string) => setSelectedNoteIds(current => {
    const next = new Set(current);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });
  const deleteSelectedBoards = async () => {
    const ids = [...selectedBoardIds];
    if (!ids.length || !window.confirm(`선택한 공간 ${ids.length}개와 그 안의 모든 메모를 삭제할까요?`)) return;
    setBulkDeleting('boards');
    try {
      const result = await boardApi.deleteMany(ids);
      const deleted = new Set(result.deletedBoardIds);
      const remaining = boards.filter(board => !deleted.has(board.id));
      const activeBoardDeleted = Boolean(boardId && deleted.has(boardId));
      setBoards(remaining);
      setSelectedBoardIds(new Set());
      if (activeBoardDeleted) {
        if (saveTimer.current) clearTimeout(saveTimer.current);
        noteRequest.current += 1;
        noteRef.current = null;
        pendingMoves.current.clear();
        setGraph(null); setSelectedId(null); setPanel(null); setNote(null); setMode('neuron'); setLinking(false); setSearch(''); setSelectedNoteIds(new Set()); setAllNotesSelected(false);
        localStorage.removeItem('memoryplace:board');
        setBoardId(remaining[0]?.id ?? null);
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : '공간을 삭제하지 못했습니다.'); }
    finally { setBulkDeleting(null); }
  };
  const deleteSelectedNotes = async () => {
    if (!boardId) return;
    const ids = [...selectedNoteIds];
    const selectedCount = allNotesSelected ? Math.max(0, (graph?.totalNodes ?? 0) - ids.length) : ids.length;
    if (!selectedCount || !window.confirm(`${allNotesSelected ? '공간의 모든 메모' : `선택한 메모 ${selectedCount}개`}를 삭제할까요? 연결도 함께 삭제됩니다.`)) return;
    setBulkDeleting('notes');
    try {
      const result = await boardApi.deleteNotes(boardId, ids, allNotesSelected);
      const deleted = new Set(result.deletedNoteIds);
      const excluded = new Set(ids);
      const shouldDelete = (noteId: string) => allNotesSelected ? !excluded.has(noteId) : deleted.has(noteId);
      const removedNodeIds = new Set((graphRef.current?.nodes ?? []).filter(node => shouldDelete(node.noteId)).map(node => node.id));
      for (const noteId of deleted) localStorage.removeItem(`memoryplace:draft:${noteId}`);
      for (const nodeId of removedNodeIds) pendingMoves.current.delete(nodeId);
      const activeNoteDeleted = Boolean(noteRef.current && shouldDelete(noteRef.current.id));
      const selectedNodeDeleted = Boolean(selectedId && removedNodeIds.has(selectedId));
      setGraph(previous => previous ? {
        ...previous,
        nodes: previous.nodes.filter(node => !shouldDelete(node.noteId)),
        edges: previous.edges.filter(edge => !removedNodeIds.has(edge.sourceNodeId) && !removedNodeIds.has(edge.targetNodeId)),
        totalNodes: Math.max(0, previous.totalNodes - result.deletedCount),
      } : previous);
      setSearchResults(current => current.filter(item => !shouldDelete(item.noteId)));
      setSelectedNoteIds(new Set()); setAllNotesSelected(false);
      if (activeNoteDeleted || selectedNodeDeleted) {
        if (saveTimer.current) clearTimeout(saveTimer.current);
        noteRef.current = null;
        setSelectedId(null); setPanel(null); setNote(null); setMode('neuron'); setLinking(false);
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : '메모를 삭제하지 못했습니다.'); }
    finally { setBulkDeleting(null); }
  };

  const deleteSelected = async () => {
    if (!note || !selectedId || !window.confirm(`‘${note.title}’ 메모를 삭제할까요?`)) return;
    try {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      await noteApi.delete(note.id);
      if (workerRef.current) workerRef.current.onmessage = null;
      pendingMoves.current.delete(selectedId);
      noteRef.current = null;
      setGraph(previous => previous ? { ...previous, nodes: previous.nodes.filter(node => node.id !== selectedId), edges: previous.edges.filter(edge => edge.sourceNodeId !== selectedId && edge.targetNodeId !== selectedId), totalNodes: Math.max(0, previous.totalNodes - 1) } : previous);
      setSelectedNoteIds(current => { const next = new Set(current); next.delete(note.id); return next; });
      setSelectedId(null); setPanel(null); setNote(null); setMode('neuron'); localStorage.removeItem(`memoryplace:draft:${note.id}`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '메모를 삭제하지 못했습니다.'); }
  };

  const panelNode = graph?.nodes.find(node => node.id === panel?.nodeId);
  const panelNote = note?.id === panelNode?.noteId ? note : null;
  const selectedEdges = graph?.edges.filter(edge => edge.sourceNodeId === panel?.nodeId || edge.targetNodeId === panel?.nodeId) ?? [];
  const updateScale = (node: GraphNode, scale: number) => {
    setGraph(previous => previous ? { ...previous, nodes: previous.nodes.map(item => item.id === node.id ? { ...item, scale } : item) } : previous);
    if (scaleTimer.current) clearTimeout(scaleTimer.current);
    scaleTimer.current = setTimeout(() => commitNode({ ...node, scale }), 260);
  };
  const finishDraft = () => {
    if (!noteRef.current) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    if (!noteRef.current.title.trim()) { updateDraft({ title: '제목 없음' }); return; }
    if (saveStatus === 'dirty') void saveDraft();
  };
  const recentNodes = useMemo(() => graph?.nodes.slice(0, 26) ?? [], [graph]);
  const allBoardsSelected = boards.length > 0 && boards.every(board => selectedBoardIds.has(board.id));
  const selectedNoteCount = allNotesSelected ? Math.max(0, (graph?.totalNodes ?? 0) - selectedNoteIds.size) : selectedNoteIds.size;

  if (booting) return <div className="loading-screen"><Logo /><div className="loading-ring" /><p>생각의 공간을 준비하고 있어요</p></div>;
  if (!user) return <AuthScreen onLogin={setUser} />;
  if (user.mustChangePassword) return <PasswordScreen onDone={setUser} />;

  return <div className="app-shell">
    <aside className={`sidebar ${sidebarOpen ? 'sidebar-open' : ''}`}>
      <div className="sidebar-header"><Logo /><button className="icon-button mobile-close" onClick={() => setSidebarOpen(false)} aria-label="메뉴 닫기">×</button></div>
      <div className="workspace-label">내 공간 <button className="mini-add" onClick={async () => { const title = window.prompt('새 공간의 이름을 입력해 주세요.'); if (!title?.trim()) return; try { const { board } = await boardApi.create(title.trim()); setBoards(current => [board, ...current]); setBoardId(board.id); } catch (cause) { setError(cause instanceof Error ? cause.message : '공간을 만들지 못했습니다.'); } }} aria-label="새 공간 만들기">+</button></div>
      {boards.length > 0 && <div className="bulk-toolbar"><label><input type="checkbox" checked={allBoardsSelected} onChange={() => setSelectedBoardIds(allBoardsSelected ? new Set() : new Set(boards.map(board => board.id)))} /> 전체</label><button className="bulk-delete" disabled={!selectedBoardIds.size || bulkDeleting !== null} onClick={() => void deleteSelectedBoards()}>{bulkDeleting === 'boards' ? '삭제 중…' : `선택 삭제 (${selectedBoardIds.size})`}</button></div>}
      <div className="board-list">{boards.map(board => <div className="sidebar-select-row" key={board.id}><label className="selection-check"><input type="checkbox" checked={selectedBoardIds.has(board.id)} onChange={() => toggleBoardSelection(board.id)} aria-label={`${board.title} 선택`} /></label><button className={`board-row ${board.id === boardId ? 'active' : ''}`} onClick={() => { setBoardId(board.id); setSidebarOpen(false); }}><span className="board-symbol">◈</span><span>{board.title}</span></button></div>)}</div>
      <div className="sidebar-divider" />
      <div className="workspace-label">생각 찾아보기 <span>{graph?.totalNodes ?? 0}</span></div>
      <div className="search-box"><span>⌕</span><input value={search} onChange={event => setSearch(event.target.value)} placeholder="제목으로 검색" aria-label="메모 검색" /></div>
      {graph && <div className="bulk-toolbar note-bulk-toolbar"><label><input type="checkbox" checked={allNotesSelected} onChange={() => { setAllNotesSelected(value => !value); setSelectedNoteIds(new Set()); }} /> 전체 선택</label><button className="bulk-delete" disabled={!selectedNoteCount || bulkDeleting !== null} onClick={() => void deleteSelectedNotes()}>{bulkDeleting === 'notes' ? '삭제 중…' : `선택 삭제 (${selectedNoteCount})`}</button></div>}
      <div className="note-list">{search.trim() ? (searchResults.length ? searchResults.map(result => <div className="sidebar-select-row" key={result.noteId}><label className="selection-check"><input type="checkbox" checked={allNotesSelected ? !selectedNoteIds.has(result.noteId) : selectedNoteIds.has(result.noteId)} onChange={() => toggleNoteSelection(result.noteId)} aria-label={`${result.title} 선택`} /></label><button className={`note-row ${result.nodeId === selectedId ? 'active' : ''}`} onClick={() => void openSearchResult(result)}><span className="note-dot" />{result.title}</button></div>) : <p className="list-empty">검색 결과가 없습니다.</p>) : recentNodes.map(node => <div className="sidebar-select-row" key={node.id}><label className="selection-check"><input type="checkbox" checked={allNotesSelected ? !selectedNoteIds.has(node.noteId) : selectedNoteIds.has(node.noteId)} onChange={() => toggleNoteSelection(node.noteId)} aria-label={`${node.title} 선택`} /></label><button className={`note-row ${node.id === selectedId ? 'active' : ''}`} onClick={() => void selectNode(node.id)}><span className="note-dot" style={{ backgroundColor: node.color }} /><span>{node.title}</span></button></div>)}</div>
      {graph?.hasMore && !search && <button className="load-more" disabled={loadingMore} onClick={async () => { if (!boardId || loadingMore) return; setLoadingMore(true); try { mergeGraph(await boardApi.graph(boardId, { offset: graph.nodes.length })); } catch (cause) { setError(cause instanceof Error ? cause.message : '더 불러오지 못했습니다.'); } finally { setLoadingMore(false); } }}>{loadingMore ? '불러오는 중…' : '더 많은 생각 불러오기 ↓'}</button>}
      <div className="sidebar-bottom"><button className="new-note-sidebar" onClick={() => void createNote()}><span>＋</span> 새 메모 만들기</button>{boardId && <a className="export-link" href={`/api/boards/${boardId}/export`} download>↧ 현재 공간 JSON 내보내기</a>}<div className="user-row"><div className="user-avatar">A</div><div><strong>{user.username}</strong><small>나의 공간</small></div><button className="logout" title="로그아웃" onClick={async () => { await authApi.logout(); setUser(null); setGraph(null); }}>↪</button></div></div>
    </aside>
    {sidebarOpen && <button className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} aria-label="메뉴 닫기" />}

    <main className="main-area">
      <header className="topbar"><div className="topbar-left"><button className="icon-button menu-button" onClick={() => setSidebarOpen(true)} aria-label="메뉴 열기">☰</button><div><div className="breadcrumb">내 공간 <span>/</span> {graph?.board.title ?? '불러오는 중'}</div><h2>{mode === 'neuron' ? '생각의 우주' : note?.title ?? '페이지'}</h2></div></div><div className="topbar-actions"><div className="mode-switch" role="tablist" aria-label="보기 방식"><button role="tab" aria-label="뉴런 모드" aria-selected={mode === 'neuron'} className={mode === 'neuron' ? 'active' : ''} onClick={() => setMode('neuron')}>✧ <span>뉴런</span></button><button role="tab" aria-label="페이지 모드" aria-selected={mode === 'page'} className={mode === 'page' ? 'active' : ''} onClick={() => { if (!selectedId && graph?.nodes[0]) void selectNode(graph.nodes[0].id, true); else { setPanel(null); setMode('page'); } }}>▤ <span>페이지</span></button></div><button className="top-add" onClick={() => void createNote()}><span>＋</span> 새 메모</button></div></header>

      {error && <div className="toast" role="alert">{error}<button onClick={() => setError('')} aria-label="알림 닫기">×</button></div>}
      {!graph && <div className="loading-content"><div className="loading-ring" />{loadingGraph ? '생각을 불러오고 있어요…' : '공간을 선택해 주세요.'}</div>}
      {graph && mode === 'neuron' && <div className="graph-view" onPointerDownCapture={event => {
        const target = event.target;
        if (target instanceof Element && !panelRef.current?.contains(target) && !target.closest('.neuron-canvas')) dismissPanel();
      }}>
        <div className="graph-glow graph-glow-a" /><div className="graph-glow graph-glow-b" />
        <Suspense fallback={<div className="graph-loading">3D 공간을 준비하고 있어요…</div>}><NeuronCanvas graph={graph} selectedId={selectedId} linking={linking} command={command} onSelect={(id, anchor) => void selectNode(id, false, anchor)} onLink={(sourceId, targetId) => void linkNodes(sourceId, targetId)} onOpen={id => void selectNode(id, true)} onBackground={dismissPanel} onAnchor={updatePanelAnchor} onCommit={commitNode} onCamera={onCamera} onMetrics={setMetrics} /></Suspense>
        <div className="graph-caption"><div className="live-dot" /><span>NEURAL SPACE</span><strong>{graph.totalNodes}개의 생각 · {graph.edges.length}개의 연결</strong></div>
        <div className="graph-help">{linking ? '연결할 다른 노드를 선택하세요' : '트랙패드·드래그: 화면 방향 이동 · Ctrl+드래그: 3D 시점 회전 · 뉴런 옆 구체를 다른 뉴런으로 드래그해 연결'}</div>
        <div className="graph-controls"><button onClick={() => setCommand({ id: Date.now(), type: 'in' })} aria-label="확대">＋</button><button onClick={() => setCommand({ id: Date.now(), type: 'out' })} aria-label="축소">−</button><span /><button onClick={() => setCommand({ id: Date.now(), type: 'fit' })} aria-label="전체 보기">◎</button></div>
        {panel && panelNode && <div ref={panelRef} key={panel.nodeId} className={`node-panel panel-${panel.phase}`}>
          <div className="panel-topline">
            <span className="panel-kind"><span className="note-dot" style={{ backgroundColor: panelNode.color }} />선택한 생각</span>
            <button className="panel-close" aria-label="선택 해제" onClick={() => dismissPanel()}>×</button>
          </div>
          <input
            className="panel-title-input"
            aria-label="선택한 생각 제목"
            value={panelNote?.title ?? panelNode.title}
            disabled={!panelNote || panel.phase === 'closing'}
            onChange={event => updateDraft({ title: event.target.value })}
            onBlur={finishDraft}
            maxLength={120}
            placeholder="생각의 제목"
          />
          <textarea
            className="panel-body-input"
            aria-label="선택한 생각 내용"
            value={panelNote?.body ?? ''}
            disabled={!panelNote || panel.phase === 'closing'}
            onChange={event => updateDraft({ body: event.target.value })}
            onBlur={finishDraft}
            maxLength={100000}
            placeholder={panelNote ? '여기에 생각을 적어 보세요…' : '메모를 불러오는 중…'}
          />
          <div className={`panel-save ${saveStatus}`}>{panelNote ? statusLabel[saveStatus] : '메모를 불러오는 중…'}</div>
          <div className="size-control"><label htmlFor="node-size">노드 크기</label><input id="node-size" type="range" min="0.5" max="3" step="0.1" value={panelNode.scale} onChange={event => updateScale(panelNode, Number(event.target.value))} /><span>{panelNode.scale.toFixed(1)}×</span></div>
          {selectedEdges.length > 0 && <div className="connections"><span>연결된 생각</span><div>{selectedEdges.slice(0, 6).map(edge => { const otherId = edge.sourceNodeId === panel.nodeId ? edge.targetNodeId : edge.sourceNodeId; const other = graph.nodes.find(node => node.id === otherId); return <div className="connection-row" key={edge.id}><button onClick={() => void selectNode(otherId)}>{other?.title ?? '다른 생각'}</button><button disabled={edge.id.startsWith('pending:')} aria-label={`${other?.title ?? '생각'} 연결 해제`} title="연결 해제" onClick={async () => { if (!boardId) return; try { await boardApi.unlink(boardId, edge.id); setGraph(previous => previous ? { ...previous, edges: previous.edges.filter(item => item.id !== edge.id) } : previous); } catch (cause) { setError(cause instanceof Error ? cause.message : '연결을 끊지 못했습니다.'); } }}>×</button></div>; })}</div></div>}
          <div className="panel-actions"><button className="primary-button" onClick={() => { setPanel(null); setMode('page'); }}>페이지 열기 ↗</button><button className={`secondary-button ${linking ? 'link-active' : ''}`} onClick={() => setLinking(value => !value)}>{linking ? '취소' : '⟷ 연결'}</button></div>
          <button className="text-danger" onClick={() => void deleteSelected()}>이 메모 삭제</button>
        </div>}
        <div className="graph-stats">{metrics.frameP95 ? `조작 프레임 p95 ${metrics.frameP95}ms · ` : ''}{metrics.visibleNodes || graph.nodes.length}개 표시 · {metrics.drawCalls || 5} draw calls</div>
      </div>}

      {graph && mode === 'page' && <div className="page-view"><div className="paper-toolbar"><div><span className="paper-kicker">YOUR NOTEBOOK</span><h3>{note?.title ?? '메모를 선택해 주세요'}</h3></div><div className="paper-actions"><span className={`save-indicator ${saveStatus}`}><i />{statusLabel[saveStatus]}</span><button className="secondary-button" onClick={() => setMode('neuron')}>✧ 그래프로 보기</button></div></div>{note ? <div className="paper-shell"><div className="paper"><div className="paper-margin" /><div className="paper-content"><input className="paper-title" value={note.title} onChange={event => updateDraft({ title: event.target.value })} placeholder="제목을 입력하세요" maxLength={120} aria-label="메모 제목" /><div className="paper-date">{new Date(note.updatedAt).toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' })}</div><textarea className="paper-body" value={note.body} onChange={event => updateDraft({ body: event.target.value })} placeholder="여기에 생각을 자유롭게 적어 보세요..." maxLength={100000} aria-label="메모 내용" /></div></div><div className="paper-footer"><span>{note.body.length.toLocaleString()}자</span><div>{saveStatus === 'conflict' && <><button onClick={async () => { const result = await noteApi.get(note.id); localStorage.removeItem(`memoryplace:draft:${note.id}`); noteRef.current = result.note; setNote(result.note); setSaveStatus('saved'); }}>서버 내용 불러오기</button><button onClick={async () => { const result = await noteApi.get(note.id); noteRef.current = { ...noteRef.current!, revision: result.note.revision }; setNote(noteRef.current); setSaveStatus('dirty'); void saveDraft(); }}>내 내용으로 저장</button></>}{saveStatus === 'offline' && <button onClick={() => void saveDraft()}>다시 저장</button>}<button className="text-danger" onClick={() => void deleteSelected()}>삭제</button></div></div></div> : <div className="page-empty"><div>▤</div><h3>아직 열린 메모가 없어요</h3><p>왼쪽 목록에서 메모를 고르거나 새로 만들어 보세요.</p><button className="primary-button" onClick={() => void createNote()}>새 메모 만들기</button></div>}</div>}
    </main>
  </div>;
}
