import { ArrowRight, Brain, EnvelopeSimple, Key, SpinnerGap, Ticket, User } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { workbenchApi } from "../api";
import type { AuthSession } from "../types";

interface AuthScreenProps {
  error: string;
  onAuthenticated: (session: AuthSession) => Promise<void>;
}

export function AuthScreen({ error, onAuthenticated }: AuthScreenProps) {
  const invitationCode = useMemo(() => new URLSearchParams(window.location.search).get("invite") || "", []);
  const [mode, setMode] = useState<"login" | "register">(invitationCode ? "register" : "login");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState("");
  const [inviteSummary, setInviteSummary] = useState("");

  useEffect(() => {
    if (!invitationCode) return;
    workbenchApi.invitationPreview(invitationCode).then((preview) => {
      if (preview.email) setEmail(preview.email);
      setInviteSummary(`${preview.organization_name}${preview.project_name ? ` · ${preview.project_name}` : ""} · ${roleLabel(preview.project_role)}`);
    }).catch((reason) => setLocalError(reason instanceof Error ? reason.message : String(reason)));
  }, [invitationCode]);

  const submit = async () => {
    setBusy(true);
    setLocalError("");
    try {
      const session = mode === "register"
        ? await workbenchApi.register(invitationCode, email.trim(), name.trim(), password)
        : await workbenchApi.login(email.trim(), password);
      await onAuthenticated(session);
      if (mode === "register") window.history.replaceState({}, "", window.location.pathname);
    } catch (reason) {
      setLocalError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return <div className="login-screen account-login"><form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
    <span className="login-icon"><Brain weight="duotone" /></span><small>CLSF AI. LAB STUDIO</small><h1>擎光绘影</h1><p>AIGC数字影像创作平台</p>
    <div className="auth-mode-tabs"><button type="button" className={mode === "login" ? "active" : ""} onClick={() => setMode("login")}>账户登录</button><button type="button" className={mode === "register" ? "active" : ""} disabled={!invitationCode} onClick={() => setMode("register")}>邀请注册</button></div>
    {mode === "register" ? <div className="invite-summary"><Ticket weight="duotone" /><span><strong>{inviteSummary || "正在核验邀请"}</strong><small>邀请码只授予指定组织和项目权限</small></span></div> : null}
    {mode === "register" ? <label><User />姓名<input value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" autoFocus placeholder="团队内显示的姓名" /></label> : null}
    <label><EnvelopeSimple />邮箱<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" autoFocus={mode === "login"} placeholder="name@example.com" /></label>
    <label><Key />密码<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={mode === "login" ? "current-password" : "new-password"} placeholder={mode === "register" ? "至少10个字符" : "输入账户密码"} /></label>
    <button className="auth-submit" disabled={busy || !email.trim() || !password || (mode === "register" && (!name.trim() || !invitationCode))}>{busy ? <SpinnerGap className="spin" /> : <ArrowRight />}{mode === "register" ? "接受邀请并进入" : "进入工作台"}</button>
    <small className="auth-note">本机访问会自动进入管理员账户；公网访问必须使用团队账户。</small>
    {localError || error ? <em>{localError || error}</em> : null}
  </form></div>;
}

function roleLabel(role: string) {
  return ({ owner: "项目负责人", editor: "制作人员", reviewer: "审核人员", viewer: "查看与下载" } as Record<string, string>)[role] || role;
}
