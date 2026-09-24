import "server-only";
import { supabaseService } from "./service";

/** Service-role client for the web app (OWNER user management). Never import in client code. */
export const supabaseAdmin = supabaseService;
