import { useRef, useState, type ReactNode } from "react";

export function AvatarUpload({ value, onChange, disabled, label, children, notify }: {
  value: string; onChange: (value: string) => void; disabled?: boolean; label: string;
  children: ReactNode; notify: (message: string, tone?: "danger") => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const load = async (file?: File) => {
    if (!file || disabled) return;
    setBusy(true);
    try {
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 5 * 1024 ** 2) throw new Error('请选择不超过5 MB的 PNG、JPEG 或 WebP 图片。');
      const bitmap = await createImageBitmap(file);
      try {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 256;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('浏览器无法处理图片。');
        const side = Math.min(bitmap.width, bitmap.height);
        ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 256, 256);
        onChange(canvas.toDataURL('image/png'));
      } finally { bitmap.close(); }
    } catch (reason) { notify(reason instanceof Error ? reason.message : '无法读取头像图片。', 'danger'); }
    finally { setBusy(false); if (input.current) input.current.value = ''; }
  };
  return <div className="avatar-upload">
    <button type="button" className="avatar-upload-preview" disabled={disabled || busy} aria-label={label} onClick={() => input.current?.click()}>{children}</button>
    {!disabled ? <><button type="button" disabled={busy} onClick={() => input.current?.click()}>{busy ? '读取中' : '上传头像'}</button>{value ? <button type="button" onClick={() => onChange('')}>移除图片</button> : null}</> : null}
    <input ref={input} hidden type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => void load(event.target.files?.[0])} />
  </div>;
}
