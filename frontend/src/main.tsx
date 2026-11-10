import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { AuthProvider } from "./context/AuthContext";
import { FriendsProvider } from "./context/FriendsContext";
import "./styles/index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <FriendsProvider>
          <App />
        </FriendsProvider>
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
