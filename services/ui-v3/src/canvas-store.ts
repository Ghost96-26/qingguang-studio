import { addEdge, applyEdgeChanges, applyNodeChanges, type Connection, type EdgeChange, type NodeChange } from "@xyflow/react";
import { create } from "zustand";
import { temporal } from "zundo";
import { connectionColor, createWorkbenchNode } from "./model";
import type { NodeKind, WorkbenchEdge, WorkbenchNode, WorkbenchNodeData } from "./types";

interface CanvasStore {
  nodes: WorkbenchNode[];
  edges: WorkbenchEdge[];
  replaceGraph: (nodes: WorkbenchNode[], edges: WorkbenchEdge[]) => void;
  onNodesChange: (changes: NodeChange<WorkbenchNode>[]) => void;
  onEdgesChange: (changes: EdgeChange<WorkbenchEdge>[]) => void;
  onConnect: (connection: Connection, outputKind?: string) => void;
  removeEdges: (ids: string[]) => void;
  addNode: (node: WorkbenchNode) => void;
  addDerivedNode: (sourceId: string, kind: NodeKind, position: { x: number; y: number }, targetPort: string, data?: Partial<WorkbenchNodeData>, outputKind?: string) => WorkbenchNode;
  updateNodeData: (id: string, patch: Partial<WorkbenchNodeData>) => void;
  deleteNodes: (ids: string[]) => void;
  duplicateNodes: (ids: string[]) => void;
  renameNode: (id: string, title: string) => void;
  groupNodes: (ids: string[]) => void;
  ungroupNodes: (ids: string[]) => void;
}

export const useCanvasStore = create<CanvasStore>()(
  temporal(
    (set, get) => ({
      nodes: [],
      edges: [],
      replaceGraph: (nodes, edges) => set({ nodes, edges }),
      onNodesChange: (changes) => set({ nodes: applyNodeChanges(changes, get().nodes) }),
      onEdgesChange: (changes) => set({ edges: applyEdgeChanges(changes, get().edges) }),
      onConnect: (connection, output = "any") => {
        if (!connection.source || !connection.target) return;
        const color = connectionColor(output);
        const target = get().nodes.find((node) => node.id === connection.target);
        const deduplicateReference = target?.data.kind === "video" && target.data.params.mode === "reference";
        const retained = get().edges.filter((edge) => {
          if (edge.target === connection.target && edge.targetHandle === connection.targetHandle) return false;
          if (deduplicateReference && edge.target === connection.target && edge.source === connection.source) return false;
          return true;
        });
        set({
          nodes: get().nodes.map((node) => node.id === connection.target && node.data.kind === "media_prepare"
            ? { ...node, data: { ...node.data, outputMediaKind: output } }
            : node),
          edges: addEdge({
            ...connection,
            id: crypto.randomUUID(),
            type: "default",
            style: { stroke: color, strokeWidth: 2 },
            data: { port: connection.targetHandle || "input", output, color },
          }, retained),
        });
      },
      removeEdges: (ids) => {
        const idSet = new Set(ids);
        set({ edges: get().edges.filter((edge) => !idSet.has(edge.id)) });
      },
      addNode: (node) => set({ nodes: [...get().nodes, node] }),
      addDerivedNode: (sourceId, kind, position, targetPort, data, output = "any") => {
        const node = createWorkbenchNode(kind, position, data);
        if (kind === "media_prepare") node.data.outputMediaKind = output;
        const color = connectionColor(output);
        set({
          nodes: [...get().nodes.map((item) => ({ ...item, selected: false })), { ...node, selected: true }],
          edges: addEdge({
            id: crypto.randomUUID(),
            source: sourceId,
            target: node.id,
            sourceHandle: "output",
            targetHandle: targetPort,
            type: "default",
            style: { stroke: color, strokeWidth: 2 },
            data: { port: targetPort, output, color },
          }, get().edges),
        });
        return node;
      },
      updateNodeData: (id, patch) => set({
        nodes: get().nodes.map((node) => node.id === id ? { ...node, data: { ...node.data, ...patch } } : node),
      }),
      deleteNodes: (ids) => {
        const idSet = new Set(ids);
        set({
          nodes: get().nodes.filter((node) => !idSet.has(node.id)),
          edges: get().edges.filter((edge) => !idSet.has(edge.source) && !idSet.has(edge.target)),
        });
      },
      duplicateNodes: (ids) => {
        const selected = get().nodes.filter((node) => ids.includes(node.id) && node.data.kind !== "group");
        const clones = selected.map((node) => ({
          ...node,
          id: crypto.randomUUID(),
          position: { x: node.position.x + 36, y: node.position.y + 36 },
          selected: true,
          data: { ...node.data, title: `${node.data.title} 副本`, productionRunId: undefined, jobId: undefined, jobIds: undefined, assetId: node.data.kind === "asset" ? node.data.assetId : undefined, assetIds: node.data.kind === "asset" ? node.data.assetIds : undefined },
        }));
        set({ nodes: [...get().nodes.map((node) => ({ ...node, selected: false })), ...clones] });
      },
      renameNode: (id, title) => set({ nodes: get().nodes.map((node) => node.id === id ? { ...node, data: { ...node.data, title } } : node) }),
      groupNodes: (ids) => {
        const selected = get().nodes.filter((node) => ids.includes(node.id) && node.data.kind !== "group");
        if (selected.length < 2) return;
        const minX = Math.min(...selected.map((node) => node.position.x)) - 32;
        const minY = Math.min(...selected.map((node) => node.position.y)) - 58;
        const maxX = Math.max(...selected.map((node) => node.position.x + (node.measured?.width || 340))) + 32;
        const maxY = Math.max(...selected.map((node) => node.position.y + (node.measured?.height || 250))) + 32;
        const group = createWorkbenchNode("group", { x: minX, y: minY }, { title: "新建分组", groupIds: selected.map((node) => node.id) });
        group.style = { width: maxX - minX, height: maxY - minY };
        group.selected = true;
        set({ nodes: [...get().nodes.map((node) => ({ ...node, selected: false })), group] });
      },
      ungroupNodes: (ids) => {
        const direct = new Set(get().nodes.filter((node) => ids.includes(node.id) && node.data.kind === "group").map((node) => node.id));
        const memberGroups = get().nodes.filter((node) => node.data.kind === "group" && node.data.groupIds?.some((id) => ids.includes(id))).map((node) => node.id);
        memberGroups.forEach((id) => direct.add(id));
        if (direct.size) set({ nodes: get().nodes.filter((node) => !direct.has(node.id)) });
      },
    }),
    {
      limit: 50,
      partialize: (state) => ({ nodes: state.nodes, edges: state.edges }),
      equality: (pastState, currentState) => pastState.nodes === currentState.nodes && pastState.edges === currentState.edges,
    },
  ),
);
