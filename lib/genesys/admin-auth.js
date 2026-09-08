import { NextResponse } from "next/server";
import { readGenesysAuthCookie } from "./auth-cookies.mjs";
import { collectGenesysRoleIds } from "./admin-role-utils.mjs";
import { hydrateRuntimeSecrets } from "./encrypted-secret-store.mjs";
import { isAllowedMutationOrigin } from "./admin-origin.mjs";
import { selectGenesysProfileImage } from "./profile-images.js";

function genesysApiBase() {
  const environment = process.env.GC_ENVIRONMENT || "mypurecloud.com";
  return `https://api.${environment}`;
}

async function genesysGet(path, accessToken) {
  const response = await fetch(`${genesysApiBase()}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  if (!response.ok) {
    const body = await response.text();
    const error = new Error(`Genesys API ${path} returned ${response.status}`);
    error.status = response.status;
    error.path = path;
    error.details = body.slice(0, 1000);
    throw error;
  }
  return response.json();
}

export async function requireWidgetAdmin(request) {
  await hydrateRuntimeSecrets({ required: false });
  const requiredRoleId = String(process.env.GC_WIDGET_ADMIN_ROLE_ID || "").trim();
  if (!requiredRoleId) {
    return {
      error: NextResponse.json(
        { error: "GC_WIDGET_ADMIN_ROLE_ID is not configured" },
        { status: 503 }
      ),
    };
  }

  const accessToken = readGenesysAuthCookie(request.cookies, "genesys_access_token");
  if (!accessToken) {
    return {
      error: NextResponse.json(
        { error: "Genesys authentication required", reauthRequired: true },
        { status: 401 }
      ),
    };
  }

  try {
    const [user, authorization] = await Promise.all([
      // Genesys omits the profile image collection unless it is explicitly
      // expanded. Keep the organization in the same request because it is
      // also used to scope every admin operation to the configured org.
      genesysGet("/api/v2/users/me?expand=organization&expand=images", accessToken),
      genesysGet("/api/v2/authorization/subjects/me", accessToken),
    ]);
    const roleIds = collectGenesysRoleIds(authorization);
    if (!roleIds.has(requiredRoleId)) {
      return {
        error: NextResponse.json(
          { error: "The required Genesys widget administrator role is missing" },
          { status: 403 }
        ),
      };
    }

    const organizationId =
      user.organization?.id || process.env.GC_ORGANIZATION_ID || null;
    if (
      process.env.GC_ORGANIZATION_ID &&
      organizationId !== process.env.GC_ORGANIZATION_ID
    ) {
      return {
        error: NextResponse.json(
          { error: "Genesys organization is not allowed" },
          { status: 403 }
        ),
      };
    }

    let profileImageUri = selectGenesysProfileImage(user.images);
    if (!profileImageUri && user.id) {
      // Expanded properties are best-effort in Genesys Cloud. A direct user
      // lookup is more reliable when /users/me omits the image collection.
      // Treat it as optional because some OAuth clients can read /users/me
      // but do not have permission to read an arbitrary /users/{id} record.
      try {
        const fullUser = await genesysGet(
          `/api/v2/users/${encodeURIComponent(user.id)}?expand=images`,
          accessToken
        );
        profileImageUri = selectGenesysProfileImage(fullUser.images);
      } catch (profileError) {
        console.warn("[genesys-admin-auth] optional profile image lookup failed", {
          path: profileError.path,
          status: profileError.status,
        });
      }
    }
    return {
      accessToken,
      profileImageUri,
      actor: {
        userId: user.id,
        userName: user.name || user.email || user.id,
        organizationId,
        profileImageUrl: profileImageUri
          ? `/api/admin/session/profile-image?user=${encodeURIComponent(user.id)}`
          : null,
      },
    };
  } catch (error) {
    console.error("[genesys-admin-auth] authorization check failed", {
      path: error.path,
      status: error.status,
      details: error.details,
    });
    const missingAuthorizationScope =
      error.status === 403 && /scope[^\n]*authorization/i.test(error.details || "");
    const status = error.status === 401 ? 401 : error.status === 403 ? 403 : 502;
    const message = status === 401
      ? "Genesys session expired"
      : missingAuthorizationScope
        ? "Genesys OAuth client is missing the authorization:readonly scope; rerun genesys:deploy and sign in again"
        : status === 403
          ? "Genesys account cannot read its authorization grants"
          : "Genesys authorization check failed";
    return {
      error: NextResponse.json(
        {
          error: message,
          reauthRequired: status === 401,
        },
        { status }
      ),
    };
  }
}

export async function requireSameOrigin(request) {
  const rawOrigin = request.headers.get("origin");
  if (!rawOrigin) {
    return NextResponse.json({ error: "Origin header is required" }, { status: 403 });
  }
  await hydrateRuntimeSecrets({ required: false });
  if (!isAllowedMutationOrigin(request)) {
    return NextResponse.json({ error: "Cross-origin mutation rejected" }, { status: 403 });
  }
  return null;
}
