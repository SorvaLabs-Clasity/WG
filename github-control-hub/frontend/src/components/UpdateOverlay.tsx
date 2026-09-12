import { useEffect, useState } from "react";

type UpdateStatus = "checking" | "downloading" | "installing" | "up-to-date" | "error" | null;

export default function UpdateOverlay() {
  const [status, setStatus] = useState<UpdateStatus>(null);
  const [version, setVersion] = useState<string>("");

  useEffect(() => {
    const api = (window as any).electronAPI;
    if (!api?.onUpdateStatus) return;
    api.onUpdateStatus((s: string, detail?: string) => {
      setStatus(s as UpdateStatus);
      if (detail) setVersion(detail);
    });
  }, []);

  if (!status || status === "up-to-date" || status === "error") return null;

  const config: Record<string, { icon: string; title: string; subtitle: string }> = {
    checking: {
      icon: "ph-magnifying-glass",
      title: "Checking for updates",
      subtitle: "Please wait...",
    },
    downloading: {
      icon: "ph-cloud-arrow-down",
      title: `Downloading update ${version}`,
      subtitle: "This will only take a moment...",
    },
    installing: {
      icon: "ph-rocket-launch",
      title: `Installing update ${version}`,
      subtitle: "The app will restart shortly...",
    },
  };

  const current = config[status];
  if (!current) return null;

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-paper">
      <div className="flex flex-col items-center gap-6 text-center px-8 max-w-[36rem]">
        <div className="w-16 h-16 border border-ink flex items-center justify-center text-ink">
          <i className={`ph-bold ${current.icon} text-3xl`}></i>
        </div>
        <div>
          <h2 className="display text-[clamp(1.5rem,3vw,2rem)] text-ink leading-tight">
            {current.title}
          </h2>
          <p className="standfirst text-[0.875rem] mt-2.5">{current.subtitle}</p>
        </div>
        {/* The measure, as a rule inking across. No spinner: this screen is a
            held page, not a widget. */}
        {status !== "installing" && (
          <div className="w-52 h-px bg-rule overflow-hidden">
            <div className="h-full w-1/3 bg-ink" style={{ animation: "ruleRun 1.15s ease-in-out infinite" }} />
          </div>
        )}
      </div>
    </div>
  );
}
