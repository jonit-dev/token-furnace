import { createRoot } from "react-dom/client";
import "./style.css";
import { App } from "./App";

const root = document.getElementById("root");
if (!root) throw new Error("index.html has no #root element");

createRoot(root).render(<App />);
