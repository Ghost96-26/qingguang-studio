import { At, Command, FilmSlate, ImageSquare, MagicWand, Timer } from "@phosphor-icons/react";
import type { Asset, NodeKind } from "../types";
import { MediaPreview } from "./MediaPreview";

export const PROMPT_PRESETS: Array<{ id: string; label: string; description: string; kinds: NodeKind[]; prompt: string; icon: typeof Command }> = [
  { id: "three-view", label: "角色三视图", description: "正面 / 侧面 / 背面，统一身份与比例", kinds: ["image_t2i", "image_i2i"], prompt: "角色三视图，正面、侧面、背面并列，身份、服装、比例与光线保持一致，干净背景。", icon: ImageSquare },
  { id: "nine-grid", label: "多机位九宫格", description: "同一角色与场景的连续镜头设计", kinds: ["image_t2i", "image_i2i"], prompt: "同一主体与场景的多机位九宫格分镜，远景、中景、近景、特写与不同机位，身份和美术设定严格一致。", icon: FilmSlate },
  { id: "relight", label: "电影级光影校正", description: "保留主体，仅优化层次与光线逻辑", kinds: ["image_i2i", "image_edit"], prompt: "保留主体身份、构图与材质，仅进行电影级光影校正：自然主辅光关系、受控高光、干净阴影、真实肤色与层次。", icon: MagicWand },
  { id: "extend-after", label: "画面推演 · 3 秒后", description: "延续当前动作与镜头运动", kinds: ["video"], prompt: "延续当前画面并推演 3 秒后的动作，保持角色身份、空间连续性、光线方向和镜头运动一致。", icon: Timer },
  { id: "extend-before", label: "画面推演 · 5 秒前", description: "回溯当前画面的合理前序动作", kinds: ["video"], prompt: "回溯当前画面 5 秒前的合理动作，保持角色身份、空间连续性、服装道具和光线一致，并自然衔接当前时刻。", icon: Timer },
];

export function PromptAssistMenu({ mode, kind, assets, onPreset, onAsset, onClose }: { mode: "slash" | "mention"; kind: NodeKind; assets: Asset[]; onPreset: (prompt: string) => void; onAsset: (asset: Asset) => void; onClose: () => void }) {
  const presets = PROMPT_PRESETS.filter((item) => item.kinds.includes(kind));
  return <div className="prompt-assist-menu" role="listbox" aria-label={mode === "slash" ? "导演指令" : "素材引用"}>
    <header>{mode === "slash" ? <Command /> : <At />}<span><strong>{mode === "slash" ? "导演指令" : "引用项目素材"}</strong><small>{mode === "slash" ? "插入高质量本地预设" : "选择后建立真实输入连接"}</small></span><button onClick={onClose}>Esc</button></header>
    {mode === "slash" ? presets.map((item) => <button key={item.id} onClick={() => onPreset(item.prompt)}><item.icon /><span><strong>{item.label}</strong><small>{item.description}</small></span></button>) : assets.slice(0, 12).map((asset) => <button key={asset.id} onClick={() => onAsset(asset)}><MediaPreview asset={asset} compact /><span><strong>{asset.name}</strong><small>{asset.kind.toUpperCase()}</small></span></button>)}
    {mode === "slash" && !presets.length ? <p>当前节点暂无可用导演指令。</p> : null}
    {mode === "mention" && !assets.length ? <p>当前模式没有可接入的兼容素材。</p> : null}
  </div>;
}
