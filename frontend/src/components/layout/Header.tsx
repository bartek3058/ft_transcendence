import { LogOut, UserRound } from "lucide-react";
import { NavLink, useNavigate } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";

export function Header() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  async function signOut() {
    try {
      await logout();
      navigate("/login", { replace: true });
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to log out.");
    }
  }

  return (
    <header>
      <NavLink className="brand" to="/">
        <span>♞</span>
        <b>ChessHub</b>
      </NavLink>
      <nav>
        <NavLink to="/" end>
          Play
        </NavLink>
        <NavLink to="/tournaments">Tournaments</NavLink>
        <NavLink to="/ranking">Ranking</NavLink>
        <NavLink to="/history">History</NavLink>
      </nav>
      <div className="user">
        <span className="dot" />
        <NavLink className="profileLink" to="/profile">
          <UserRound size={17} />
          <span>{user?.username}</span>
        </NavLink>
        <button
          className="icon"
          aria-label="Log out"
          title="Log out"
          onClick={() => void signOut()}
        >
          <LogOut size={18} />
        </button>
      </div>
    </header>
  );
}
