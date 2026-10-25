import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { readBasePath } from "./lib/base";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<App base={readBasePath()} />
	</StrictMode>,
);
