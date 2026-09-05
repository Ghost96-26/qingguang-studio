import {
  DotsThreeVertical,
  DownloadSimple,
  Folder,
  FolderOpen,
  MagnifyingGlass,
  PencilSimple,
  Plus,
  SquaresFour,
  Toolbox,
  Trash,
  UploadSimple,
  UsersThree,
  X,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { mediaKind } from "../model";
import type { Asset, AssetFolder } from "../types";
import { InlineNameEditor } from "./InlineNameEditor";
import { MediaPreview } from "./MediaPreview";

interface AssetDrawerProps {
  open: boolean;
  projectName: string;
  assets: Asset[];
  folders: AssetFolder[];
  onClose: () => void;
  onAdd: (asset: Asset) => void;
  onUpload: (folderId?: string | null) => void;
  onCreateFolder: (parentId?: string | null) => void;
  onRenameFolder: (folder: AssetFolder, name: string) => void;
  onDeleteFolder: (folder: AssetFolder) => void;
  onMoveAsset: (asset: Asset, folderId: string) => void;
  onRenameAsset: (asset: Asset, name: string) => void;
  onDownload: (asset: Asset) => void;
  readOnly?: boolean;
}

const CATEGORY_META = [
  { key: "all", label: "全部素材", Icon: SquaresFour },
  { key: "scene", label: "场景设定", Icon: FolderOpen },
  { key: "character", label: "人物设定", Icon: UsersThree },
  { key: "prop", label: "道具设定", Icon: Toolbox },
  { key: "unfiled", label: "未归档", Icon: Folder },
] as const;

export function AssetDrawer({
  open,
  projectName,
  assets,
  folders,
  onClose,
  onAdd,
  onUpload,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onMoveAsset,
  onRenameAsset,
  onDownload,
  readOnly = false,
}: AssetDrawerProps) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [folderId, setFolderId] = useState("all");
  const [menuAssetId, setMenuAssetId] = useState<string | null>(null);
  const [editingAssetId, setEditingAssetId] = useState<string | null>(null);
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
  const folderById = useMemo(() => new Map(folders.map((folder) => [folder.id, folder])), [folders]);
  const selectedFolder = folderId === "all" ? undefined : folderById.get(folderId);
  const customFolders = folders.filter((folder) => !folder.system_key);

  useEffect(() => {
    if (folderId !== "all" && !folderById.has(folderId)) setFolderId("all");
  }, [folderById, folderId]);
  useEffect(() => { if (!open) { setMenuAssetId(null); setEditingAssetId(null); setEditingFolderId(null); } }, [open]);

  const descendantIds = useMemo(() => {
    if (!selectedFolder) return null;
    const result = new Set([selectedFolder.id]);
    let changed = true;
    while (changed) {
      changed = false;
      folders.forEach((folder) => {
        if (folder.parent_id && result.has(folder.parent_id) && !result.has(folder.id)) {
          result.add(folder.id);
          changed = true;
        }
      });
    }
    return result;
  }, [folders, selectedFolder]);

  const filtered = useMemo(() => assets.filter((asset) => {
    const kind = mediaKind(asset);
    const inFolder = !descendantIds || Boolean(asset.folder_id && descendantIds.has(asset.folder_id));
    return inFolder && (filter === "all" || kind === filter) && asset.name.toLowerCase().includes(query.trim().toLowerCase());
  }), [assets, descendantIds, filter, query]);

  const selectCategory = (key: string) => {
    if (key === "all") setFolderId("all");
    else setFolderId(folders.find((folder) => folder.system_key === key)?.id || "all");
    setMenuAssetId(null);
  };
  const categoryIsActive = (key: string) => key === "all" ? folderId === "all" : selectedFolder?.system_key === key;
  const countFor = (key: string) => {
    if (key === "all") return assets.length;
    const root = folders.find((folder) => folder.system_key === key);
    if (!root) return 0;
    return assets.filter((asset) => {
      let current = asset.folder_id ? folderById.get(asset.folder_id) : undefined;
      const visited = new Set<string>();
      while (current && !visited.has(current.id)) {
        if (current.id === root.id) return true;
        visited.add(current.id);
        current = current.parent_id ? folderById.get(current.parent_id) : undefined;
      }
      return false;
    }).length;
  };

  return <aside className={`asset-drawer ${open ? "open" : ""}`} aria-hidden={!open}>{open ? <>
    <header><div><small>ASSET LIBRARY</small><strong>项目资产</strong></div><button onClick={onClose} aria-label="关闭素材库"><X /></button></header>
    <div className="asset-project-path"><FolderOpen weight="duotone" /><span><small>当前位置</small><strong>{projectName} / {selectedFolder?.path || "全部素材"}</strong></span></div>
    <nav className="asset-folder-nav" aria-label="素材文件夹">
      {CATEGORY_META.map(({ key, label, Icon }) => <button key={key} className={categoryIsActive(key) ? "active" : ""} onClick={() => selectCategory(key)}>
        <Icon weight="duotone" /><span>{label}</span><small>{countFor(key)}</small>
      </button>)}
    </nav>
    <div className="asset-custom-row"><span>自定义文件夹</span>{!readOnly ? <button onClick={() => onCreateFolder(selectedFolder?.id)} aria-label="新建素材文件夹"><Plus />新建</button> : null}</div>
    {customFolders.length ? <div className="asset-custom-folders">
      {customFolders.map((folder) => <div key={folder.id} className={`asset-custom-folder ${folderId === folder.id ? "active" : ""}`} onClick={() => setFolderId(folder.id)} onDoubleClick={() => { setFolderId(folder.id); setEditingFolderId(folder.id); }} title={`${folder.path} · 双击重命名`}><Folder /><span>{folder.name}</span><small>{assets.filter((asset) => asset.folder_id === folder.id).length}</small></div>)}
    </div> : null}
    {selectedFolder && !selectedFolder.system_key ? <div className="asset-folder-actions">{readOnly ? <strong>{selectedFolder.name}</strong> : <><InlineNameEditor value={selectedFolder.name} editing={editingFolderId === selectedFolder.id} onEditingChange={(editing) => setEditingFolderId(editing ? selectedFolder.id : null)} onCommit={(name) => onRenameFolder(selectedFolder, name)} ariaLabel="文件夹名称" /><button onClick={() => setEditingFolderId(selectedFolder.id)}><PencilSimple />重命名</button><button className="danger" onClick={() => onDeleteFolder(selectedFolder)}><Trash />删除文件夹</button></>}</div> : null}
    <label className="asset-search"><MagnifyingGlass /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`搜索${selectedFolder?.name || "项目"}素材`} /></label>
    <div className="asset-filters">{[["all", "全部"], ["image", "图片"], ["video", "视频"], ["audio", "音频"]].map(([value, label]) => <button className={filter === value ? "active" : ""} onClick={() => setFilter(value)} key={value}>{label}</button>)}</div>
    <div className="asset-grid">
      {filtered.map((asset) => {
        const folder = folderById.get(asset.folder_id || "");
        const menuOpen = menuAssetId === asset.id;
        return <article key={asset.id} draggable={!readOnly} onDragStart={(event) => event.dataTransfer.setData("application/x-workbench-asset", asset.id)} onDoubleClick={() => { if (!readOnly) onAdd(asset); }}>
          <div className="asset-thumb"><MediaPreview asset={asset} compact />{!readOnly ? <button className="asset-add" onClick={() => onAdd(asset)} aria-label={`将 ${asset.name} 放入画布`}><Plus /></button> : null}</div>
          {readOnly ? <strong className="asset-card-name">{asset.name}</strong> : <InlineNameEditor value={asset.name} editing={editingAssetId === asset.id} onEditingChange={(editing) => setEditingAssetId(editing ? asset.id : null)} onCommit={(name) => onRenameAsset(asset, name)} className="asset-card-name" ariaLabel="素材名称" />}<span>{mediaKind(asset).toUpperCase()}</span>
          <small className="asset-folder-path" title={folder?.path || "未归档"}><Folder />{folder?.path || "未归档"}</small>
          <button className="asset-manage" onClick={(event) => { event.stopPropagation(); setMenuAssetId(menuOpen ? null : asset.id); }} aria-label={`管理 ${asset.name}`}><DotsThreeVertical /></button>
          {menuOpen ? <div className="asset-card-menu" onPointerDown={(event) => event.stopPropagation()}>
            {!readOnly ? <button onClick={() => { setEditingAssetId(asset.id); setMenuAssetId(null); }}><PencilSimple />原位重命名</button> : null}
            <button onClick={() => { onDownload(asset); setMenuAssetId(null); }}><DownloadSimple />远程下载</button>
            {!readOnly ? <label><Folder />移动到<select value={asset.folder_id || ""} onChange={(event) => { onMoveAsset(asset, event.target.value); setMenuAssetId(null); }}>
              {folders.map((item) => <option key={item.id} value={item.id}>{item.path}</option>)}
            </select></label> : null}
          </div> : null}
        </article>;
      })}
      {!filtered.length ? <div className="empty-assets"><FolderOpen /><strong>这个文件夹还没有素材</strong><span>导入后会自动显示在当前分类中</span></div> : null}
    </div>
    {!readOnly ? <button className="drawer-upload" onClick={() => onUpload(selectedFolder?.id)}><UploadSimple />导入到 {selectedFolder?.name || "未归档"}</button> : null}
  </> : null}</aside>;
}
