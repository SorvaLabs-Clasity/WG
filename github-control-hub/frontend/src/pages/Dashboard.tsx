import Navbar from "../components/Navbar";
import RepoList from "../components/RepoList";
import { useAuth } from "../App";

export default function Dashboard() {
  const { user } = useAuth();

  return (
    <div className="bg-gh-bg text-gh-textBase min-h-screen pt-14">
      <Navbar login={user?.login} avatarUrl={user?.avatarUrl} />
      <main className="flex-1 max-w-7xl mx-auto w-full px-4 sm:px-6 lg:px-8 py-8 animate-fade-in">
        <RepoList />
      </main>
    </div>
  );
}
