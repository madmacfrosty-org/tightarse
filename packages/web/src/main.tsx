import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { cognitoSession, httpApi } from "./adapters";
import "./theme.css";

// The composition root: the one place the dashboard's ports are bound to
// Cognito and to fetch.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App session={cognitoSession} api={httpApi} />
  </StrictMode>,
);
