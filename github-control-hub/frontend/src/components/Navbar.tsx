import { useNavigate, useLocation } from "react-router-dom";
import { clearToken } from "../api/client";

interface NavbarProps {
  login?: string;
  avatarUrl?: string;
}

export default function Navbar({ login, avatarUrl }: NavbarProps) {
  const navigate = useNavigate();
  const location = useLocation();

  const handleLogout = () => {
    clearToken();
    navigate("/login");
  };

  const isRepos = location.pathname === "/" || location.pathname.startsWith("/repo");
  const isTemplates = location.pathname.startsWith("/templates");
  const isSecurity = location.pathname.startsWith("/security");
  const isCompliance = location.pathname.startsWith("/compliance");
  const isDependencies = location.pathname.startsWith("/dependencies");
  const isMonitoring = location.pathname.startsWith("/monitoring");
  const isActivity = location.pathname.startsWith("/activity");

  return (
    <nav className="bg-gh-dark fixed top-0 left-0 right-0 h-14 z-40 flex items-center justify-between px-6 border-b border-black/10 shadow-sm text-white">
      {/* Left: Logo & Title */}
      <div 
        className="flex items-center gap-3 cursor-pointer transition-opacity hover:opacity-80"
        onClick={() => navigate("/")}
      >
        <i className="ph-fill ph-github-logo text-3xl"></i>
        <span className="font-bold tracking-tight text-sm">GitHub Control Hub</span>
      </div>

      {/* Middle: Navigation Links */}
      <div className="hidden md:flex items-center gap-6 absolute left-1/2 -translate-x-1/2 h-full">
        <button 
          onClick={() => navigate("/")}
          className={`h-full flex items-center text-sm font-medium border-b-2 px-1 gap-1.5 transition-colors ${
            isRepos ? "text-white border-white" : "text-gray-400 hover:text-gray-300 border-transparent"
          }`}
        >
          <i className="ph ph-git-repository text-lg"></i>
          Repos
        </button>
        <button 
          onClick={() => navigate("/templates")}
          className={`h-full flex items-center text-sm font-medium border-b-2 px-1 gap-1.5 transition-colors ${
            isTemplates ? "text-white border-white" : "text-gray-400 hover:text-gray-300 border-transparent"
          }`}
        >
          <i className="ph ph-copy text-lg"></i>
          Templates
        </button>
        <button 
          onClick={() => navigate("/security")}
          className={`h-full flex items-center text-sm font-medium border-b-2 px-1 gap-1.5 transition-colors ${
            isSecurity ? "text-white border-white" : "text-gray-400 hover:text-gray-300 border-transparent"
          }`}
        >
          <i className="ph ph-shield-warning text-lg"></i>
          Security
        </button>
        <button 
          onClick={() => navigate("/compliance")}
          className={`h-full flex items-center text-sm font-medium border-b-2 px-1 gap-1.5 transition-colors ${
            isCompliance ? "text-white border-white" : "text-gray-400 hover:text-gray-300 border-transparent"
          }`}
        >
          <i className="ph ph-check-square-offset text-lg"></i>
          Compliance
        </button>
        <button 
          onClick={() => navigate("/dependencies")}
          className={`h-full flex items-center text-sm font-medium border-b-2 px-1 gap-1.5 transition-colors ${
            isDependencies ? "text-white border-white" : "text-gray-400 hover:text-gray-300 border-transparent"
          }`}
        >
          <i className="ph ph-bug text-lg"></i>
          Dependabot
        </button>
        <button 
          onClick={() => navigate("/monitoring")}
          className={`h-full flex items-center text-sm font-medium border-b-2 px-1 gap-1.5 transition-colors ${
            isMonitoring ? "text-white border-white" : "text-gray-400 hover:text-gray-300 border-transparent"
          }`}
        >
          <i className="ph ph-binoculars text-lg"></i>
          Scanners
        </button>
        <button 
          onClick={() => navigate("/activity")}
          className={`h-full flex items-center text-sm font-medium border-b-2 px-1 gap-1.5 transition-colors ${
            isActivity ? "text-white border-white" : "text-gray-400 hover:text-gray-300 border-transparent"
          }`}
        >
          <i className="ph ph-activity text-lg"></i>
          Activity
        </button>
      </div>

      {/* Right: User Profile */}
      <div className="flex items-center gap-4">
        {login && (
          <>
            <div className="flex items-center gap-2 group cursor-pointer">
              {avatarUrl ? (
                <img 
                  src={avatarUrl} 
                  alt={`${login} avatar`} 
                  className="w-7 h-7 rounded-full object-cover border border-white/20 group-hover:border-white/50 transition-colors" 
                />
              ) : (
                <div className="w-7 h-7 rounded-full border border-white/20 flex items-center justify-center bg-gray-700">
                  <i className="ph-fill ph-user text-xs"></i>
                </div>
              )}
              <span className="text-gray-300 group-hover:text-white text-sm font-medium transition-colors hidden sm:block">
                {login}
              </span>
            </div>
            <div className="w-px h-5 bg-gray-600"></div>
          </>
        )}
        <button 
          onClick={handleLogout}
          className="text-gray-400 hover:text-white transition-colors flex items-center gap-1.5 text-sm font-medium"
        >
          <i className="ph ph-sign-out text-lg"></i>
          <span className="hidden sm:inline">Logout</span>
        </button>
      </div>
    </nav>
  );
}
