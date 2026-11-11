import { LogOut, Menu, X, UserRound } from "lucide-react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { useEffect, useState } from "react";
import { useAuth } from "../../context/AuthContext";

export function Header() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

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
      <NavLink className="brand" to="/" onClick={() => setMenuOpen(false)}>
        <span>♞</span>
        <b>ChessHub</b>
      </NavLink>
      <button
        type="button"
        className="mobileNavToggle"
        aria-label={menuOpen ? "Close navigation" : "Open navigation"}
        aria-expanded={menuOpen}
        aria-controls="main-navigation"
        onClick={() => setMenuOpen((open) => !open)}
      >
        {menuOpen ? <X size={22} /> : <Menu size={22} />}
      </button>

      <nav
        id="main-navigation"
        className={menuOpen ? "mainNav mobileNavOpen" : "mainNav"}
        aria-label="Main navigation"
        onClick={(event) => {
          if ((event.target as HTMLElement).closest("a")) {
            setMenuOpen(false);
          }
        }}
      >
        <NavLink to="/" end>
          Play
        </NavLink>
        <NavLink to="/ai">vs AI</NavLink>
        <NavLink to="/tournaments">Tournaments</NavLink>
        <NavLink to="/ranking">Ranking</NavLink>
        <NavLink to="/history">History</NavLink>
        <NavLink to="/friends">Friends</NavLink>
      </nav>
      <div className="user">
        <span className="dot" />
        <NavLink
          className="profileLink"
          to="/profile"
          onClick={() => setMenuOpen(false)}
        >
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
