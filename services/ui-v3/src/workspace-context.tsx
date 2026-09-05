import { createContext, useContext } from "react";
import type { H3IRPreview } from "./h3-director";
import type { Asset, Capabilities, Job, NodeKind, NodeReadiness, WorkbenchParams } from "./types";

export interface WorkspaceContextValue {
  assets: Asset[];
  jobs: Job[];
  capabilities: Capabilities | null;
  projectId: string;
  canEditProject: boolean;
  canReviewProject: boolean;
  reviewJob: (jobId: string, status: "approved" | "rejected" | "pending") => Promise<void>;
  notify: (message: string, tone?: "default" | "success" | "danger") => void;
  renameNode: (id: string) => void;
  deriveNode: (sourceId: string, kind: NodeKind, targetPort?: string, params?: WorkbenchParams) => void;
  runNode: (id: string) => Promise<void>;
  optimizePrompt: (id: string) => Promise<void>;
  compileH3: (id: string) => Promise<H3IRPreview>;
  getPlaybackUrl: (assetId: string) => Promise<string>;
  inspectAsset: (assetId: string) => Promise<Asset>;
  saveMask: (nodeId: string, file: File, annotation: string) => Promise<void>;
  changeVideoMode: (nodeId: string, mode: string) => void;
  disconnectInput: (edgeId: string) => void;
  attachAsset: (nodeId: string, assetId: string, targetPort?: string) => boolean;
  getNodeReadiness: (nodeId: string) => NodeReadiness;
  startRuntime: () => Promise<void>;
  runtimeStarting: boolean;
}

export const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function useWorkspace() {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("WorkspaceContext is unavailable");
  return value;
}
