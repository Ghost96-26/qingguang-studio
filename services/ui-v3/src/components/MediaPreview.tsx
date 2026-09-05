import { File, Image as ImageIcon, MusicNotes, VideoCamera } from "@phosphor-icons/react";
import { memo, useEffect, useState } from "react";
import { mediaKind } from "../model";
import type { Asset } from "../types";
import { useWorkspace } from "../workspace-context";

interface MediaPreviewProps {
  asset?: Asset;
  compact?: boolean;
}

function MediaPreviewComponent({ asset, compact = false }: MediaPreviewProps) {
  const { getPlaybackUrl } = useWorkspace();
  const [url, setUrl] = useState("");
  const kind = mediaKind(asset);

  useEffect(() => {
    let alive = true;
    setUrl("");
    if (asset?.id && kind !== "file") {
      getPlaybackUrl(asset.id).then((next) => {
        if (alive) setUrl(next);
      }).catch(() => undefined);
    }
    return () => { alive = false; };
  }, [asset?.id, getPlaybackUrl, kind]);

  if (!asset) {
    return <div className={`media-empty ${compact ? "compact" : ""}`}><ImageIcon weight="duotone" /><span>等待生成结果</span></div>;
  }
  if (kind === "image" && url) return <img className="media-content" src={url} alt={asset.name} draggable={false} />;
  if (kind === "video" && url) return <video className="media-content" src={url} muted preload="metadata" controls={!compact} />;
  if (kind === "audio" && url) return (
    <div className="audio-preview"><MusicNotes weight="duotone" /><div><strong>{asset.name}</strong><audio src={url} controls preload="metadata" /></div></div>
  );
  const Icon = kind === "video" ? VideoCamera : kind === "image" ? ImageIcon : File;
  return <div className={`media-empty ${compact ? "compact" : ""}`}><Icon weight="duotone" /><span>{asset.name}</span></div>;
}

export const MediaPreview = memo(MediaPreviewComponent);
