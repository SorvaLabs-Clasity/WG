import { getLoginUrl } from "../api/auth";

export default function LoginPage() {
  const handleLogin = () => {
    window.location.href = getLoginUrl();
  };

  return (
    <div className="mesh-gradient h-screen w-full flex items-center justify-center p-4 relative text-[#24292f]">
      {/* Noise Texture */}
      <div className="noise-overlay"></div>

      {/* Decorative shapes for depth */}
      <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-white opacity-[0.05] rounded-full blur-3xl -translate-x-1/2 -translate-y-1/2 pointer-events-none animate-pulse"></div>
      <div className="absolute bottom-1/4 right-1/4 w-[500px] h-[500px] bg-purple-900 opacity-[0.1] rounded-full blur-3xl translate-x-1/3 translate-y-1/3 pointer-events-none"></div>

      {/* Main Container */}
      <main className="w-full max-w-[440px] relative z-20">
        
        {/* Login Card */}
        <div className="glass-card rounded-2xl p-10 md:p-12 text-center fade-in-up border border-gray-100/50 relative overflow-hidden">
          
          {/* Top Subtle Highlight Bar */}
          <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-gray-200 to-transparent opacity-50"></div>

          {/* Icon */}
          <div className="mb-8 flex justify-center">
            <div className="w-16 h-16 bg-gray-50 rounded-xl flex items-center justify-center border border-gray-100 shadow-sm transform transition-transform hover:scale-105 duration-300">
              <i className="fa-brands fa-github text-4xl text-[#24292f]"></i>
            </div>
          </div>

          {/* Typography */}
          <h1 className="text-3xl font-bold tracking-tight text-gray-900 mb-4">
            GitHub Control Hub
          </h1>
          
          <p className="text-[15px] leading-relaxed text-gray-500 mb-10 mx-auto max-w-[320px]">
            Manage your organization's repositories, branches, and branch protections in one place.
          </p>

          {/* SSO Action */}
          <div className="space-y-6">
            <button 
              onClick={handleLogin}
              className="github-btn-glow group w-full bg-[#24292f] hover:bg-[#32383f] text-white font-medium py-3.5 px-4 rounded-xl transition-all duration-300 transform hover:-translate-y-0.5 flex items-center justify-center relative overflow-hidden"
            >
              {/* Button Shine Effect */}
              <div className="absolute inset-0 w-full h-full bg-gradient-to-r from-transparent via-white/10 to-transparent -translate-x-full group-hover:animate-shine transition-none"></div>
              
              <i className="fa-brands fa-github text-xl mr-3 group-hover:rotate-12 transition-transform duration-300"></i>
              <span>Sign in with GitHub</span>
            </button>

            {/* Footer / Help Links */}
            <div className="fade-in-delayed pt-2">
              <div className="flex items-center justify-center gap-4 text-xs text-gray-400 font-medium">
                <a href="#" className="hover:text-gray-600 transition-colors" rel="nofollow">Documentation</a>
                <span className="w-1 h-1 rounded-full bg-gray-300"></span>
                <a href="#" className="hover:text-gray-600 transition-colors" rel="nofollow">Support</a>
                <span className="w-1 h-1 rounded-full bg-gray-300"></span>
                <a href="#" className="hover:text-gray-600 transition-colors" rel="nofollow">Status</a>
              </div>
            </div>
          </div>
        </div>

        {/* Bottom Copyright */}
        <div className="text-center mt-8 fade-in-delayed opacity-0" style={{ animationDelay: '0.4s', animationFillMode: 'forwards' }}>
          <p className="text-white/60 text-xs font-medium tracking-wide">
            &copy; 2026 Organization Internal Tools. Secure Access Only.
          </p>
        </div>

      </main>
    </div>
  );
}
