import { useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { setToken } from "../api/client";
import { Spinner } from "../design";

/**
 * Where GitHub sends you back to after signing in.
 *
 * On screen for a fraction of a second, so it stays deliberately plain. This
 * used to be the only reason the app depended on a component library.
 */
export default function AuthCallback() {
  const navigate = useNavigate();
  const [params] = useSearchParams();

  useEffect(() => {
    const token = params.get("token");
    if (token) {
      setToken(token);
      navigate("/", { replace: true });
    } else {
      navigate("/login", { replace: true });
    }
  }, [params, navigate]);

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-paper">
      <p className="display text-[1.75rem] text-ink mb-1">GitHub Control Hub</p>
      <Spinner label="Authenticating" />
    </div>
  );
}
