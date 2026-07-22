import { useState } from "react";
import { IconLoader2, IconSparkles } from "@tabler/icons-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TEMPLATES } from "@/templates";
import { api } from "@/api";
import type { ProviderName } from "@/types";

export function CreateCampaignDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: (id: string) => void;
}) {
  const [name, setName] = useState("Summer promo");
  const [templateId, setTemplateId] = useState(TEMPLATES[0].id);
  const tpl = TEMPLATES.find((t) => t.id === templateId)!;
  const [subject, setSubject] = useState(tpl.subject);
  const [body, setBody] = useState(tpl.body);
  const [mode, setMode] = useState<"dryrun" | "live">("dryrun");
  const [liveProvider, setLiveProvider] = useState<Exclude<ProviderName, "dryrun">>("ses");
  const [count, setCount] = useState(1_000_000);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const applyTemplate = (id: string) => {
    const t = TEMPLATES.find((x) => x.id === id)!;
    setTemplateId(id);
    setSubject(t.subject);
    setBody(t.body);
  };

  const submit = async () => {
    setBusy(true);
    setErr("");
    try {
      const provider: ProviderName = mode === "dryrun" ? "dryrun" : liveProvider;
      const c = await api.createCampaign({ name, subject, bodyTemplate: body, provider });
      await api.generateRecipients(c.id, count);
      onOpenChange(false);
      onCreated(c.id);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <IconSparkles size={20} className="text-primary" /> Create campaign
          </DialogTitle>
          <DialogDescription>
            The campaign is saved as a <b>draft</b>. Start it when you're ready.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 max-h-[60vh] overflow-y-auto pr-1">
          <div className="grid gap-2">
            <Label htmlFor="cf-name">Campaign name</Label>
            <Input id="cf-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-2">
              <Label>Template</Label>
              <Select value={templateId} onValueChange={applyTemplate}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TEMPLATES.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label>Recipients</Label>
              <Input
                type="number"
                value={count}
                onChange={(e) => setCount(Number(e.target.value))}
              />
            </div>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="cf-subject">Subject</Label>
            <Input id="cf-subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="cf-body">
              HTML body — supports <code className="text-primary">{"{{name}}"}</code> and{" "}
              <code className="text-primary">{"{{unsubscribeUrl}}"}</code>
            </Label>
            <Textarea id="cf-body" rows={7} value={body} onChange={(e) => setBody(e.target.value)} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-2">
              <Label>Mode</Label>
              <Select value={mode} onValueChange={(v) => setMode(v as "dryrun" | "live")}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="dryrun">Dry run (simulated)</SelectItem>
                  <SelectItem value="live">Live (real provider)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label>Provider</Label>
              <Select
                value={mode === "dryrun" ? "dryrun" : liveProvider}
                onValueChange={(v) => setLiveProvider(v as Exclude<ProviderName, "dryrun">)}
                disabled={mode === "dryrun"}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {mode === "dryrun" ? (
                    <SelectItem value="dryrun">Dry run</SelectItem>
                  ) : (
                    <>
                      <SelectItem value="ses">Amazon SES</SelectItem>
                      <SelectItem value="resend">Resend</SelectItem>
                    </>
                  )}
                </SelectContent>
              </Select>
            </div>
          </div>

          {err && <div className="text-sm text-red-400">{err}</div>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy || !name.trim()}>
            {busy && <IconLoader2 size={16} className="animate-spin" />}
            {busy ? "Creating…" : "Create campaign"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
