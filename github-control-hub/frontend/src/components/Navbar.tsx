import { useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { clearToken } from "../api/client";
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
    clearToken();
    navigate("/login");
  };

  const isRepos = location.pathname === "/" || location.pathname.startsWith("/repo");
  const isTemplates = location.pathname.startsWith("/templates");
  const isSecurity = location.pathname.startsWith("/security");
  const isCompliance = location.pathname.startsWith("/compliance");
  const isDependencies = location.pathname.startsWith("/dependencies");
  const isGraph = location.pathname.startsWith("/graph");
  const isAnalytics = location.pathname.startsWith("/analytics");
  const isActivity = location.pathname.startsWith("/activity");

  const navItems = [
    { label: "Repos", icon: "ph-git-repository", path: "/", isActive: isRepos },
    { label: "Templates", icon: "ph-copy", path: "/templates", isActive: isTemplates },
    { label: "Security", icon: "ph-shield-warning", path: "/security", isActive: isSecurity },
    { label: "Compliance", icon: "ph-check-square-offset", path: "/compliance", isActive: isCompliance },
    { label: "Dependabot", icon: "ph-bug", path: "/dependencies", isActive: isDependencies },
    { label: "Analytics", icon: "ph-chart-bar", path: "/analytics", isActive: isAnalytics },
    { label: "Graph", icon: "ph-graph", path: "/graph", isActive: isGraph },
    { label: "Activity", icon: "ph-activity", path: "/activity", isActive: isActivity },
  ];

  return (
    <>
      <nav className="bg-gh-dark fixed top-0 left-0 right-0 h-14 z-40 flex items-center justify-between px-4 sm:px-6 border-b border-black/10 shadow-sm text-white">
        <div className="flex items-center gap-3">
          <button 
            className="xl:hidden p-1 -ml-1 text-gray-400 hover:text-white transition-colors"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          >
            <i className={`ph ${mobileMenuOpen ? 'ph-x' : 'ph-list'} text-2xl`}></i>
          </button>
          <div 
            className="flex items-center gap-2 sm:gap-3 cursor-pointer transition-opacity hover:opacity-80"
            onClick={() => navigate("/")}
          >
            <i className="ph-fill ph-github-logo text-2xl sm:text-3xl"></i>
            <span className="font-bold tracking-tight text-sm hidden sm:inline-block">GitHub Control Hub</span>
          </div>
        </div>

        <div className="hidden xl:flex items-center gap-6 absolute left-1/2 -translate-x-1/2 h-full">
          {navItems.map(item => (
            <button 
              key={item.path}
              onClick={() => navigate(item.path)}
              className={`h-full flex items-center text-sm font-medium border-b-2 px-1 gap-1.5 transition-colors ${
                item.isActive ? "text-white border-white" : "text-gray-400 hover:text-gray-300 border-transparent"
              }`}
            >
              <i className={`ph ${item.icon} text-lg`}></i>
              {item.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-3 sm:gap-4">
          {login && (
            <>
              <div className="flex items-center gap-2">
                <UserAvatar login={login} avatarUrl={avatarUrl} size={28} className="border border-white/20" />
                <span className="text-gray-300 text-sm font-medium hidden md:block">
                  {login}
                </span>
              </div>
              <div className="w-px h-5 bg-gray-600 hidden sm:block"></div>
            </>
          )}
          <button 
            onClick={handleLogout}
            className="text-gray-400 hover:text-white transition-colors flex items-center gap-1.5 text-sm font-medium"
            title="Logout"
          >
            <i className="ph ph-sign-out text-lg"></i>
            <span className="hidden sm:inline">Logout</span>
          </button>
        </div>
      </nav>

      {/* Mobile Menu */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 top-14 z-30 bg-gh-dark/95 backdrop-blur-sm xl:hidden border-t border-white/10 animate-fade-in overflow-y-auto">
          <div className="flex flex-col p-4 gap-2">
            {navItems.map(item => (
              <button
                key={item.path}
                onClick={() => {
                  navigate(item.path);
                  setMobileMenuOpen(false);
                }}
                className={`flex items-center gap-3 px-4 py-3 rounded-lg text-left transition-colors ${
                  item.isActive ? "bg-white/10 text-white font-semibold" : "text-gray-300 hover:bg-white/5 hover:text-white"
                }`}
              >
                <i className={`ph ${item.icon} text-xl`}></i>
                {item.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
