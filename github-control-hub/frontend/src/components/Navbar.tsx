import { useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import UserAvatar from "./UserAvatar";

interface NavbarProps {
  login?: string;
  avatarUrl?: string;
}

export default function Navbar({ login, avatarUrl }: NavbarProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const handleLogout = () => {
    navigate("/login");
  };

  const isTemplates = location.pathname.startsWith("/templates");
  const isSecurity = location.pathname.startsWith("/security");
  const isCompliance = location.pathname.startsWith("/compliance");
  const isDependencies = location.pathname.startsWith("/dependencies");
  const isGraph = location.pathname.startsWith("/graph");
  const isAnalytics = location.pathname === "/" || location.pathname.startsWith("/analytics");
  const isActivity = location.pathname.startsWith("/activity");

  const navItems = [
    { label: "Templates", icon: "ph-copy", path: "/templates", isActive: isTemplates },
    { label: "Security", icon: "ph-shield-warning", path: "/security", isActive: isSecurity },
    { label: "Compliance", icon: "ph-check-square-offset", path: "/compliance", isActive: isCompliance },
    { label: "Dependabot", icon: "ph-bug", path: "/dependencies", isActive: isDependencies },
    { label: "Analytics", icon: "ph-chart-bar", path: "/analytics", isActive: isAnalytics },
    { label: "Knowledge Map", icon: "ph-graph", path: "/graph", isActive: isGraph },
    { label: "Activity", icon: "ph-activity", path: "/activity", isActive: isActivity },
  ];

  return (
    <>
      <nav className="bg-white fixed top-0 left-0 right-0 h-14 z-40 flex items-center px-4 sm:px-6 border-b border-slate-200">
        <div className="flex items-center gap-3 shrink-0">
          <button 
            className="xl:hidden p-1 -ml-1 text-slate-400 hover:text-slate-900 transition-colors"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          >
            <i className={`ph ${mobileMenuOpen ? 'ph-x' : 'ph-list'} text-2xl`}></i>
          </button>
          <div 
            className="flex items-center gap-2 cursor-pointer group"
            onClick={() => navigate("/")}
          >
            <i className="ph-fill ph-github-logo text-2xl sm:text-3xl text-slate-900"></i>
            <span className="font-bold text-slate-900 tracking-tight text-sm hidden sm:inline-block">
              GitHub <span className="text-slate-400 font-normal">Control Hub</span>
            </span>
          </div>
        </div>

        <div className="hidden xl:flex items-center gap-6 ml-8 h-full">
          {navItems.map(item => (
            <button 
              key={item.path}
              onClick={() => navigate(item.path)}
              className={`h-full flex items-center text-sm font-medium border-b-2 px-0.5 transition-colors ${
                item.isActive
                  ? "text-slate-900 border-slate-900"
                  : "text-slate-500 hover:text-slate-900 border-transparent"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-3 sm:gap-4">
          {login && (
            <div className="flex items-center gap-2">
              <UserAvatar login={login} avatarUrl={avatarUrl} size={28} className="border border-slate-200" />
              <span className="text-slate-600 text-sm font-medium hidden md:block">
                {login}
              </span>
            </div>
          )}
          <button 
            onClick={handleLogout}
            className="text-slate-400 hover:text-slate-900 transition-colors flex items-center gap-1.5 text-sm font-medium"
            title="Session"
          >
            <i className="ph ph-gear-six text-lg"></i>
            <span className="hidden sm:inline">Session</span>
          </button>
        </div>
      </nav>

      {/* Mobile Menu */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 top-14 z-30 bg-white/95 backdrop-blur-sm xl:hidden border-t border-slate-200 animate-fade-in overflow-y-auto">
          <div className="flex flex-col p-4 gap-1">
            {navItems.map(item => (
              <button
                key={item.path}
                onClick={() => {
                  navigate(item.path);
                  setMobileMenuOpen(false);
                }}
                className={`flex items-center gap-3 px-4 py-3 rounded-lg text-left transition-colors ${
                  item.isActive
                    ? "bg-slate-100 text-slate-900 font-semibold"
                    : "text-slate-500 hover:bg-slate-50 hover:text-slate-900"
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
