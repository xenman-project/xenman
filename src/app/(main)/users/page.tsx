"use client";

import React, { useEffect, useState, useCallback } from "react";
import { useAuth, type UserRole } from "@/context/auth-context";
import { useRouter } from "next/navigation";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ArrowLeft,
  MoreVertical,
  Pencil,
  Trash2,
  Plus,
  KeyRound,
  Users,
  ShieldCheck,
  Wrench,
  Eye,
  Mail,
  Clock,
  LogOut,
} from "lucide-react";
import Link from "next/link";
import { PASSWORD_MIN_LENGTH, passwordProblem } from "@/lib/password-policy";

interface UserRecord {
  username: string;
  role: UserRole;
  createdAt: string;
  email?: string;
  invited?: boolean;
  /** Host ids (one per pool) this user may access. Admins ignore this. */
  pools?: string[];
}

/** Pools an admin can hand out, from /api/hosts. */
interface PoolOption {
  id: string;
  name: string;
  address: string;
}

const roleBadge: Record<UserRole, { label: string; className: string }> = {
  admin: {
    label: "Admin",
    className:
      "bg-red-500/10 text-red-600 border-red-500/20 dark:text-red-400",
  },
  operator: {
    label: "Operator",
    className:
      "bg-blue-500/10 text-blue-600 border-blue-500/20 dark:text-blue-400",
  },
  viewer: {
    label: "Viewer",
    className:
      "bg-zinc-500/10 text-zinc-600 border-zinc-500/20 dark:text-zinc-400",
  },
};

const roleIcon: Record<UserRole, React.ReactNode> = {
  admin: <ShieldCheck className="mr-1.5 h-3 w-3" />,
  operator: <Wrench className="mr-1.5 h-3 w-3" />,
  viewer: <Eye className="mr-1.5 h-3 w-3" />,
};

export default function UsersPage() {
  const { role, username: currentUser, loading: authLoading } = useAuth();
  const router = useRouter();
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Add user dialog
  const [addOpen, setAddOpen] = useState(false);
  const [addUsername, setAddUsername] = useState("");
  const [addPassword, setAddPassword] = useState("");
  const [addEmail, setAddEmail] = useState("");
  const [addRole, setAddRole] = useState<UserRole>("operator");
  const [addError, setAddError] = useState("");
  const [addLoading, setAddLoading] = useState(false);

  // Edit user dialog
  const [editUser, setEditUser] = useState<UserRecord | null>(null);
  const [editRole, setEditRole] = useState<UserRole>("operator");
  const [editEmail, setEditEmail] = useState("");
  const [editPools, setEditPools] = useState<string[]>([]);
  const [editError, setEditError] = useState("");
  const [editLoading, setEditLoading] = useState(false);

  // Configured pools available for assignment
  const [pools, setPools] = useState<PoolOption[]>([]);

  // Reset password dialog
  const [resetPwUser, setResetPwUser] = useState<string | null>(null);
  const [resetPassword, setResetPassword] = useState("");
  const [resetConfirm, setResetConfirm] = useState("");
  const [resetError, setResetError] = useState("");
  const [resetLoading, setResetLoading] = useState(false);

  // Resend invite
  const [resendLoading, setResendLoading] = useState<string | null>(null);

  // Delete confirmation
  const [deleteUsername, setDeleteUsername] = useState<string | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  // Redirect non-admins
  useEffect(() => {
    if (!authLoading && role !== "admin") {
      router.push("/");
    }
  }, [authLoading, role, router]);

  const fetchUsers = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/users");
      if (res.ok) {
        setUsers(await res.json());
      } else {
        const data = await res.json();
        setError(data.error || "Failed to load users");
      }
    } catch {
      setError("Failed to load users");
    } finally {
      setLoading(false);
    }
  }, []);

  // As an admin this returns every configured pool, so it doubles as the list
  // of assignable pools.
  const fetchPools = useCallback(async () => {
    try {
      const res = await fetch("/api/hosts");
      if (!res.ok) return;
      const hosts: PoolOption[] = await res.json();
      setPools(hosts.map((h) => ({ id: h.id, name: h.name, address: h.address })));
    } catch {
      // Non-fatal: the assignment list simply stays empty.
    }
  }, []);

  useEffect(() => {
    if (role === "admin") {
      fetchUsers();
      fetchPools();
    }
  }, [role, fetchUsers, fetchPools]);

  async function handleAddUser() {
    setAddError("");
    setAddLoading(true);
    try {
      const body: Record<string, string> = {
        username: addUsername,
        role: addRole,
        email: addEmail,
      };
      if (addPassword) body.password = addPassword;
      const res = await fetch("/api/auth/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setAddError(data.error || "Failed to create user");
        return;
      }
      setAddOpen(false);
      setAddUsername("");
      setAddPassword("");
      setAddEmail("");
      setAddRole("operator");
      fetchUsers();
    } catch {
      setAddError("Failed to create user");
    } finally {
      setAddLoading(false);
    }
  }

  async function handleResendInvite(username: string) {
    setResendLoading(username);
    try {
      const res = await fetch("/api/auth/users", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username }),
      });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "Failed to resend invitation");
      }
    } catch {
      setError("Failed to resend invitation");
    } finally {
      setResendLoading(null);
    }
  }

  /** Ends every sign-in of the user: each browser has to sign in again. */
  async function handleSignOut(username: string) {
    try {
      const res = await fetch(`/api/auth/users/${encodeURIComponent(username)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signOut: true }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || "Failed to sign the user out");
      }
    } catch {
      setError("Failed to sign the user out");
    }
  }

  async function handleEditUser() {
    if (!editUser) return;
    setEditError("");
    setEditLoading(true);
    try {
      const isSelf = editUser.username.toLowerCase() === currentUser?.toLowerCase();
      const body: Record<string, string | string[]> = { email: editEmail };
      if (!isSelf) body.role = editRole;
      // Admins reach every pool by definition, so the list is only sent for
      // the other roles.
      if (editRole !== "admin") body.pools = editPools;
      const res = await fetch(
        `/api/auth/users/${encodeURIComponent(editUser.username)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const data = await res.json();
      if (!res.ok) {
        setEditError(data.error || "Failed to update user");
        return;
      }
      setEditUser(null);
      fetchUsers();
    } catch {
      setEditError("Failed to update user");
    } finally {
      setEditLoading(false);
    }
  }

  async function handleResetPassword() {
    if (!resetPwUser) return;
    if (resetPassword !== resetConfirm) {
      setResetError("Passwords do not match");
      return;
    }
    const problem = passwordProblem(resetPassword, resetPwUser);
    if (problem) {
      setResetError(problem);
      return;
    }
    setResetError("");
    setResetLoading(true);
    try {
      const res = await fetch(
        `/api/auth/users/${encodeURIComponent(resetPwUser)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ newPassword: resetPassword }),
        },
      );
      const data = await res.json();
      if (!res.ok) {
        setResetError(data.error || "Failed to reset password");
        return;
      }
      setResetPwUser(null);
      setResetPassword("");
      setResetConfirm("");
    } catch {
      setResetError("Failed to reset password");
    } finally {
      setResetLoading(false);
    }
  }

  async function handleDeleteUser() {
    if (!deleteUsername) return;
    setDeleteLoading(true);
    try {
      const res = await fetch(
        `/api/auth/users/${encodeURIComponent(deleteUsername)}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "Failed to delete user");
      }
      setDeleteUsername(null);
      fetchUsers();
    } catch {
      setError("Failed to delete user");
    } finally {
      setDeleteLoading(false);
    }
  }

  if (authLoading || role !== "admin") {
    return null;
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl px-3 pb-20 pt-3 sm:px-6 sm:pt-6 md:pb-6">
        {/* Header */}
        <div className="mb-6 flex items-center gap-3">
          <Link href="/">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">
              User Management
            </h1>
            <p className="text-sm text-zinc-500">
              Manage user accounts and roles
            </p>
          </div>
        </div>

        {error && (
          <div className="mb-4 rounded-md bg-red-50 p-3 text-sm text-red-600 dark:bg-red-950/50 dark:text-red-400">
            {error}
            <button
              className="ml-2 underline"
              onClick={() => setError("")}
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Users Card */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Users className="h-4 w-4 text-zinc-500" />
                <div>
                  <CardTitle className="text-base">Users</CardTitle>
                  <CardDescription>
                    {users.length} user{users.length !== 1 ? "s" : ""}{" "}
                    registered
                  </CardDescription>
                </div>
              </div>
              <Button size="sm" onClick={() => setAddOpen(true)}>
                <Plus className="mr-1.5 h-3.5 w-3.5" />
                Add User
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {loading ? (
              <p className="text-sm text-zinc-500">Loading...</p>
            ) : (
              <div className="rounded-md border dark:border-zinc-800">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Username</TableHead>
                      <TableHead>Email</TableHead>
                      <TableHead>Role</TableHead>
                      <TableHead>Pools</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="w-12" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {users.map((user) => {
                      const isSelf =
                        user.username.toLowerCase() ===
                        currentUser?.toLowerCase();
                      const badge = roleBadge[user.role];
                      return (
                        <TableRow key={user.username}>
                          <TableCell className="font-medium">
                            {user.username}
                            {isSelf && (
                              <Badge
                                variant="outline"
                                className="ml-2 text-[10px]"
                              >
                                you
                              </Badge>
                            )}
                          </TableCell>
                          <TableCell className="text-zinc-500">
                            {user.email || "—"}
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant="outline"
                              className={badge.className}
                            >
                              {roleIcon[user.role]}
                              {badge.label}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            {user.role === "admin" ? (
                              <span className="text-xs text-zinc-500">
                                All pools
                              </span>
                            ) : !user.pools || user.pools.length === 0 ? (
                              <Badge
                                variant="outline"
                                className="bg-red-500/10 text-red-600 border-red-500/20 dark:text-red-400"
                              >
                                No access
                              </Badge>
                            ) : (
                              <span
                                className="text-xs text-zinc-600 dark:text-zinc-400"
                                title={user.pools
                                  .map(
                                    (id) =>
                                      pools.find((p) => p.id === id)?.name || id,
                                  )
                                  .join(", ")}
                              >
                                {user.pools.length === 1
                                  ? pools.find((p) => p.id === user.pools![0])
                                      ?.name || "1 pool"
                                  : `${user.pools.length} pools`}
                              </span>
                            )}
                          </TableCell>
                          <TableCell>
                            {user.invited ? (
                              <Badge
                                variant="outline"
                                className="bg-amber-500/10 text-amber-600 border-amber-500/20 dark:text-amber-400"
                              >
                                <Clock className="mr-1.5 h-3 w-3" />
                                Invited
                              </Badge>
                            ) : (
                              <Badge
                                variant="outline"
                                className="bg-emerald-500/10 text-emerald-600 border-emerald-500/20 dark:text-emerald-400"
                              >
                                Active
                              </Badge>
                            )}
                          </TableCell>
                          <TableCell>
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8"
                                >
                                  <MoreVertical className="h-4 w-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem
                                  onClick={() => {
                                    setEditUser(user);
                                    setEditRole(user.role);
                                    setEditEmail(user.email || "");
                                    setEditPools(user.pools ?? []);
                                    setEditError("");
                                  }}
                                >
                                  <Pencil className="mr-2 h-4 w-4" />
                                  Edit
                                </DropdownMenuItem>
                                {user.invited ? (
                                  <DropdownMenuItem
                                    disabled={resendLoading === user.username}
                                    onClick={() => handleResendInvite(user.username)}
                                  >
                                    <Mail className="mr-2 h-4 w-4" />
                                    {resendLoading === user.username ? "Sending..." : "Resend Invite"}
                                  </DropdownMenuItem>
                                ) : (
                                  <DropdownMenuItem
                                    onClick={() => {
                                      setResetPwUser(user.username);
                                      setResetPassword("");
                                      setResetConfirm("");
                                      setResetError("");
                                    }}
                                  >
                                    <KeyRound className="mr-2 h-4 w-4" />
                                    Reset Password
                                  </DropdownMenuItem>
                                )}
                                <DropdownMenuItem
                                  disabled={isSelf || user.invited}
                                  onClick={() => handleSignOut(user.username)}
                                >
                                  <LogOut className="mr-2 h-4 w-4" />
                                  Sign Out Everywhere
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  disabled={isSelf}
                                  className="text-red-600 focus:text-red-600"
                                  onClick={() =>
                                    setDeleteUsername(user.username)
                                  }
                                >
                                  <Trash2 className="mr-2 h-4 w-4" />
                                  Delete
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Role Legend */}
        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="text-base">Role Permissions</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 text-sm">
              <div className="flex items-start gap-3">
                <Badge
                  variant="outline"
                  className={`mt-0.5 shrink-0 ${roleBadge.admin.className}`}
                >
                  {roleIcon.admin}
                  Admin
                </Badge>
                <span className="text-zinc-600 dark:text-zinc-400">
                  Full access including user management and host configuration
                </span>
              </div>
              <div className="flex items-start gap-3">
                <Badge
                  variant="outline"
                  className={`mt-0.5 shrink-0 ${roleBadge.operator.className}`}
                >
                  {roleIcon.operator}
                  Operator
                </Badge>
                <span className="text-zinc-600 dark:text-zinc-400">
                  VM actions (power, migrate, create, delete, console, settings)
                  but no user management or host configuration
                </span>
              </div>
              <div className="flex items-start gap-3">
                <Badge
                  variant="outline"
                  className={`mt-0.5 shrink-0 ${roleBadge.viewer.className}`}
                >
                  {roleIcon.viewer}
                  Viewer
                </Badge>
                <span className="text-zinc-600 dark:text-zinc-400">
                  Read-only access — can view dashboards and VM details but
                  cannot perform any actions
                </span>
              </div>
            </div>
            <p className="mt-4 border-t pt-3 text-xs text-zinc-500 dark:border-zinc-800">
              The role decides <em>what</em> a user may do, the pool assignment
              decides <em>where</em>. Both apply: an operator without an assigned
              pool sees nothing. Admins always reach every configured pool.
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Add User Dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add User</DialogTitle>
            <DialogDescription>
              Create a new user account with a specific role.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="grid gap-2">
              <Label htmlFor="add-username">Username</Label>
              <Input
                id="add-username"
                value={addUsername}
                onChange={(e) => {
                  setAddUsername(e.target.value);
                  setAddError("");
                }}
                placeholder="Enter username"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="add-email">Email</Label>
              <Input
                id="add-email"
                type="email"
                value={addEmail}
                onChange={(e) => {
                  setAddEmail(e.target.value);
                  setAddError("");
                }}
                placeholder="user@example.com"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="add-password">Password</Label>
              <Input
                id="add-password"
                type="password"
                value={addPassword}
                onChange={(e) => {
                  setAddPassword(e.target.value);
                  setAddError("");
                }}
                placeholder={addEmail ? "Leave empty to send invitation" : `Min. ${PASSWORD_MIN_LENGTH} characters`}
              />
              {addEmail && !addPassword && (
                <p className="text-xs text-zinc-500">
                  An invitation email will be sent to set the password.
                </p>
              )}
            </div>
            <div className="grid gap-2">
              <Label>Role</Label>
              <Select
                value={addRole}
                onValueChange={(v) => setAddRole(v as UserRole)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="admin">Admin</SelectItem>
                  <SelectItem value="operator">Operator</SelectItem>
                  <SelectItem value="viewer">Viewer</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {addError && (
              <p className="text-sm text-red-500">{addError}</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleAddUser}
              disabled={addLoading || !addUsername || (!addPassword && !addEmail)}
            >
              {addLoading
                ? "Creating..."
                : addEmail && !addPassword
                  ? "Send Invitation"
                  : "Add User"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit User Dialog */}
      <Dialog
        open={editUser !== null}
        onOpenChange={(open) => !open && setEditUser(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit User</DialogTitle>
            <DialogDescription>
              Update details for <strong>{editUser?.username}</strong>.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="grid gap-2">
              <Label htmlFor="edit-email">Email</Label>
              <Input
                id="edit-email"
                type="email"
                value={editEmail}
                onChange={(e) => {
                  setEditEmail(e.target.value);
                  setEditError("");
                }}
                placeholder="user@example.com"
              />
            </div>
            {editUser?.username.toLowerCase() !== currentUser?.toLowerCase() && (
              <div className="grid gap-2">
                <Label>Role</Label>
                <Select
                  value={editRole}
                  onValueChange={(v) => {
                    setEditRole(v as UserRole);
                    setEditError("");
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="admin">Admin</SelectItem>
                    <SelectItem value="operator">Operator</SelectItem>
                    <SelectItem value="viewer">Viewer</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* Pool assignment — admins always reach everything, so the list is
                only meaningful for the other roles. */}
            <div className="grid gap-2">
              <Label>Pools</Label>
              {editRole === "admin" ? (
                <p className="text-sm text-zinc-500">
                  Admins have access to all pools.
                </p>
              ) : pools.length === 0 ? (
                <p className="text-sm text-zinc-500">
                  No pools configured yet — add one under Settings first.
                </p>
              ) : (
                <>
                  <div className="max-h-44 space-y-1 overflow-y-auto rounded-md border p-2 dark:border-zinc-800">
                    {pools.map((pool) => {
                      const checked = editPools.includes(pool.id);
                      return (
                        <label
                          key={pool.id}
                          className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
                        >
                          <input
                            type="checkbox"
                            className="h-3.5 w-3.5 accent-zinc-900 dark:accent-zinc-100"
                            checked={checked}
                            onChange={(e) => {
                              setEditPools((prev) =>
                                e.target.checked
                                  ? [...prev, pool.id]
                                  : prev.filter((id) => id !== pool.id),
                              );
                              setEditError("");
                            }}
                          />
                          <span className="flex-1">{pool.name || pool.address}</span>
                          <span className="text-xs text-zinc-400">
                            {pool.address}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                  {editPools.length === 0 && (
                    <p className="text-xs text-amber-600 dark:text-amber-400">
                      Without an assignment this user sees nothing.
                    </p>
                  )}
                </>
              )}
            </div>

            {editError && (
              <p className="text-sm text-red-500">{editError}</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditUser(null)}>
              Cancel
            </Button>
            <Button
              onClick={handleEditUser}
              disabled={editLoading}
            >
              {editLoading ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reset Password Dialog */}
      <Dialog
        open={resetPwUser !== null}
        onOpenChange={(open) => !open && setResetPwUser(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reset Password</DialogTitle>
            <DialogDescription>
              Set a new password for <strong>{resetPwUser}</strong>.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="grid gap-2">
              <Label htmlFor="reset-password">New Password</Label>
              <Input
                id="reset-password"
                type="password"
                value={resetPassword}
                onChange={(e) => {
                  setResetPassword(e.target.value);
                  setResetError("");
                }}
                placeholder={`Min. ${PASSWORD_MIN_LENGTH} characters`}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="reset-confirm">Confirm Password</Label>
              <Input
                id="reset-confirm"
                type="password"
                value={resetConfirm}
                onChange={(e) => {
                  setResetConfirm(e.target.value);
                  setResetError("");
                }}
              />
            </div>
            {resetError && (
              <p className="text-sm text-red-500">{resetError}</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResetPwUser(null)}>
              Cancel
            </Button>
            <Button
              onClick={handleResetPassword}
              disabled={resetLoading || !resetPassword || !resetConfirm}
            >
              {resetLoading ? "Resetting..." : "Reset Password"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog
        open={deleteUsername !== null}
        onOpenChange={(open) => !open && setDeleteUsername(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete User</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete{" "}
              <strong>{deleteUsername}</strong>? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700 text-white"
              onClick={handleDeleteUser}
              disabled={deleteLoading}
            >
              {deleteLoading ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
