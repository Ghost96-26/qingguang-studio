import { Aperture, ArrowsClockwise, FilmSlate, Images, MagicWand, MicrophoneStage, MusicNotes, NotePencil, SlidersHorizontal, UsersThree, VideoCamera, Waveform } from "@phosphor-icons/react";
import type { NodeKind } from "../types";

const tools: Array<{ kind: NodeKind; label: string; icon: typeof Aperture }> = [
  { kind: "image_t2i", label: "图片生成", icon: Aperture },
  { kind: "image_i2i", label: "图生图", icon: ArrowsClockwise },
  { kind: "image_edit", label: "图片编辑", icon: MagicWand },
  { kind: "media_prepare", label: "素材适配", icon: SlidersHorizontal },
  { kind: "video", label: "视频生成", icon: VideoCamera },
  { kind: "tts", label: "角色对白", icon: MicrophoneStage },
  { kind: "dialogue", label: "对白编排", icon: UsersThree },
  { kind: "music", label: "音乐生成", icon: MusicNotes },
  { kind: "sfx", label: "影视音效", icon: Waveform },
  { kind: "note", label: "便笺", icon: NotePencil },
];

export function ToolRail({ onAdd, onToggleAssets, assetOpen, readOnly }: { onAdd: (kind: NodeKind) => void; onToggleAssets: () => void; assetOpen: boolean; readOnly: boolean }) {
  return <aside className="tool-rail" aria-label="创建节点">
    <div className="rail-section-label">CREATE</div>
    {tools.map(({ kind, label, icon: Icon }) => <button key={kind} onClick={() => onAdd(kind)} title={readOnly ? `${label} · 当前项目只读` : label} aria-label={label} disabled={readOnly}><Icon weight="duotone" /><span>{label}</span></button>)}
    <div className="rail-spacer" />
    <button className={assetOpen ? "active" : ""} onClick={onToggleAssets} title="项目资产" aria-label="项目资产"><Images weight="duotone" /><span>资产</span></button>
    <button onClick={() => onAdd("group")} title={readOnly ? "新建分组 · 当前项目只读" : "新建分组"} aria-label="新建分组" disabled={readOnly}><FilmSlate weight="duotone" /><span>分组</span></button>
  </aside>;
}
