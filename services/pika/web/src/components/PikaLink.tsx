import { Link, type LinkProps } from "react-router";
import { useApi } from "../lib/api";

/** Keep session and project navigation inside the anonymous gallery while browsing public data. */
export function PikaLink({ to, ...props }: LinkProps) {
	const api = useApi();
	const path = (value: string) => api.publicView && value.startsWith("/") && !value.startsWith("//") ? `/public${value}` : value;
	return <Link {...props} to={typeof to === "string" ? path(to) : { ...to, pathname: to.pathname ? path(to.pathname) : undefined }} />;
}
