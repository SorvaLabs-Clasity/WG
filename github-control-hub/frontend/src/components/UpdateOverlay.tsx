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
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-white/80 dark:bg-slate-950/80 backdrop-blur-sm">
      <div className="flex flex-col items-center gap-5 text-center px-8">
        <div className="relative">
          <div className="w-16 h-16 rounded-2xl bg-slate-900 dark:bg-white flex items-center justify-center">
            <i className={`ph ${current.icon} text-3xl text-white dark:text-slate-900`}></i>
          </div>
          {status !== "installing" && (
            <div className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full bg-slate-900 dark:bg-white flex items-center justify-center">
              <div className="w-2.5 h-2.5 rounded-full border-2 border-white dark:border-slate-900 border-t-transparent dark:border-t-transparent animate-spin"></div>
            </div>
          )}
        </div>
        <div>
          <h2 className="text-lg font-semibold text-slate-900 dark:text-white">
            {current.title}
          </h2>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
            {current.subtitle}
          </p>
        </div>
      </div>
    </div>
  );
}
