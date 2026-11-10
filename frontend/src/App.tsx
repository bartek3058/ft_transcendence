import { Navigate, Route, Routes } from "react-router-dom";
import { Header } from "./components/layout/Header";
import { ProtectedRoute } from "./components/auth/ProtectedRoute";
import { GamePage } from "./pages/GamePage";
import { TournamentGamePage } from "./pages/TournamentGamePage";
import { AiGamePage } from "./pages/AiGamePage";
import { TournamentsPage } from "./pages/TournamentsPage";
import { TournamentDetailsPage } from "./pages/TournamentDetailsPage";
import { RankingPage } from "./pages/RankingPage";
import { HistoryPage } from "./pages/HistoryPage";
import { LoginPage } from "./pages/LoginPage";
import { RegisterPage } from "./pages/RegisterPage";
import { ProfilePage } from "./pages/ProfilePage";
import { FriendsPage } from "./pages/FriendsPage";
import { PublicUserPage } from "./pages/PublicUserPage";

function AppLayout() {
  return (
    <div className="app">
      <Header />
      <main>
        <Routes>
          <Route path="/" element={<GamePage />} />
          <Route path="/game/:gameId" element={<TournamentGamePage />} />
          <Route path="/ai" element={<AiGamePage />} />
          <Route path="/tournaments" element={<TournamentsPage />} />
          <Route path="/tournaments/:id" element={<TournamentDetailsPage />} />
          <Route path="/ranking" element={<RankingPage />} />
          <Route path="/history" element={<HistoryPage />} />
          <Route path="/profile" element={<ProfilePage />} />
          <Route path="/friends" element={<FriendsPage />} />
          <Route path="/users/:id" element={<PublicUserPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route element={<ProtectedRoute />}>
        <Route path="/*" element={<AppLayout />} />
      </Route>
    </Routes>
  );
}
