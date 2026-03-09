import { Button } from "@mui/material";
import GitHubIcon from "@mui/icons-material/GitHub";
import { getLoginUrl } from "../api/auth";

export default function LoginButton() {
  const handleLogin = () => {
    window.location.href = getLoginUrl();
  };

  return (
    <Button
      variant="contained"
      size="large"
      startIcon={<GitHubIcon />}
      onClick={handleLogin}
      sx={{
        bgcolor: "#24292f",
        "&:hover": { bgcolor: "#32383f" },
        textTransform: "none",
        px: 4,
        py: 1.5,
        fontSize: "1.1rem",
        borderRadius: 2,
      }}
    >
      Sign in with GitHub
    </Button>
  );
}
