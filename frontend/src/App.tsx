import { Navigate, Route, Routes } from 'react-router-dom';
import { Header } from './components/layout/Header';
import { ProtectedRoute } from './components/auth/ProtectedRoute';
import { GamePage } from './pages/GamePage';
import { TournamentsPage } from './pages/TournamentsPage';
import { RankingPage } from './pages/RankingPage';
import { HistoryPage } from './pages/HistoryPage';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';

function AppLayout(){return <div className="app"><Header/><main><Routes><Route path="/" element={<GamePage/>}/><Route path="/tournaments" element={<TournamentsPage/>}/><Route path="/ranking" element={<RankingPage/>}/><Route path="/history" element={<HistoryPage/>}/><Route path="*" element={<Navigate to="/" replace/>}/></Routes></main></div>}
export default function App(){return <Routes><Route path="/login" element={<LoginPage/>}/><Route path="/register" element={<RegisterPage/>}/><Route element={<ProtectedRoute/>}><Route path="/*" element={<AppLayout/>}/></Route></Routes>}
