import { TRPCError } from "@trpc/server";
import { getAppPool, withWorkspace } from "@workloom/db";
import { z } from "zod";
import { AccessAuthorityError, resolveAuthoritativeClientAccess } from "../../service/access-authority.js";
import { protectedProcedure, router } from "../../trpc/context.js";
import {
  BOT_CAPABILITIES, createMandateInput, manualTaskInput, OperatingBotError, operatingBot,
} from "../operating-bot/engine.js";
import {
  confirmActionInput, confirmFactsInput, getBriefInput, listActionsInput, listFactsInput, listOutcomeEvidenceInput,
  OperatingError, operatingService, previewFactsInput, recordActionOutcomeInput, reviewInput,
  verifyActionOutcomeInput, type OperatingScope,
} from "./operating-service.js";

const navigationPermission = "consulting.business.read";
const identifier = z.string().uuid();
const taskInput = z.object({ taskId: identifier }).strict();
const mandateInput = z.object({ mandateId: identifier }).strict();
const evidenceInput = z.object({ factIds: z.array(identifier).min(1).max(50) }).strict();
const taskEventsInput = taskInput.extend({
  after: z.string().regex(/^\d{1,19}$/u).optional(),
  limit: z.number().int().min(1).max(100).optional(),
}).strict();

export interface BusinessAuthority {
  scope: OperatingScope;
  actor: { memberId: string; memberNo: string };
  role: string;
  memberName: string;
  canManage: boolean;
  canWrite: boolean;
  canConfirmAction: boolean;
  canDispatchBot: boolean;
  canConfigureBot: boolean;
}

const businessRead = protectedProcedure.use(async ({ ctx, next }) => {
  let access: Awaited<ReturnType<typeof resolveAuthoritativeClientAccess>>;
  try {
    access = await resolveAuthoritativeClientAccess(ctx.identity);
  } catch (error) {
    if (error instanceof AccessAuthorityError) {
      throw new TRPCError({ code: error.code === "SESSION_INVALID" ? "UNAUTHORIZED" : "FORBIDDEN", message: error.message });
    }
    throw error;
  }
  if (access.subject.kind !== "member" || !access.bundle.configured
      || access.bundle.bundleId !== "consulting"
      || !access.navigationPermissions.includes(navigationPermission)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "当前工作区或成员未获得鹰眼经营工作台访问权" });
  }
  const { id, role, name, memberNo } = access.subject;
  const canManage = role === "owner" || role === "manager";
  const canWrite = access.actionPermissions.includes("workspace.write");
  const canDispatchBot = canManage && canWrite && access.actionPermissions.includes("task.dispatch");
  const authority: BusinessAuthority = {
    actor: { memberId: id, memberNo },
    scope: { ...access.scope, memberId: id, manager: canManage },
    role,
    memberName: name,
    canManage,
    canWrite,
    canConfirmAction: canManage && canWrite && access.actionPermissions.includes("approval.decide"),
    canDispatchBot,
    canConfigureBot: role === "owner" && canDispatchBot && access.actionPermissions.includes("workspace.configure"),
  };
  return next({ ctx: { authority } });
});

function requirePermission(authority: BusinessAuthority, key: keyof Pick<BusinessAuthority,
  "canManage" | "canWrite" | "canConfirmAction" | "canDispatchBot" | "canConfigureBot">) {
  if (!authority[key]) {
    throw new TRPCError({ code: "FORBIDDEN", message: "当前成员无权执行此经营操作" });
  }
}

async function reportErrors<T>(operation: () => T | Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof OperatingError) {
      throw new TRPCError({ code: error.code, message: error.message, cause: error });
    }
    if (error instanceof OperatingBotError) {
      const code = error.code === "NOT_FOUND" ? "NOT_FOUND"
        : error.code === "FORBIDDEN" ? "FORBIDDEN"
          : error.code === "QUEUE_FULL" ? "TOO_MANY_REQUESTS"
          : error.code === "INVALID_INPUT" ? "BAD_REQUEST" : "CONFLICT";
      throw new TRPCError({ code, message: error.message, cause: error });
    }
    throw error;
  }
}

async function workspacePresentation(authority: BusinessAuthority) {
  const { scope } = authority;
  return withWorkspace(getAppPool(), scope, async (_db, client) => {
    const workspace = (await client.query<{ is_example: boolean }>(
      "SELECT is_example FROM workspaces WHERE id=$1 AND tenant_id=$2",
      [scope.workspaceId, scope.tenantId],
    )).rows[0];
    if (!workspace) throw new TRPCError({ code: "NOT_FOUND", message: "工作区不存在或已撤销" });
    const members = authority.canManage ? (await client.query<{ id: string; name: string; memberNo: string }>(
      `SELECT m.id, m.name, m.member_no AS "memberNo"
         FROM members m
        WHERE m.workspace_id=$1 AND m.status='active'
          AND m.member_no<>'GUEST' AND m.role IN ('owner','manager','staff')
        ORDER BY m.name, m.id LIMIT 300`,
      [scope.workspaceId],
    )).rows : [];
    return { dataMode: workspace.is_example ? "simulated" as const : "real" as const, members };
  });
}

export const businessRouter = router({
  context: businessRead.query(async ({ ctx: { authority } }) => ({
    memberId: authority.actor.memberId,
    memberName: authority.memberName,
    role: authority.role,
    canManage: authority.canManage,
    canWrite: authority.canWrite,
    canConfirmAction: authority.canConfirmAction,
    canDispatchBot: authority.canDispatchBot,
    canConfigureBot: authority.canConfigureBot,
    ...await workspacePresentation(authority),
  })),
  previewFacts: businessRead.input(previewFactsInput).mutation(({ ctx: { authority }, input }) => {
    requirePermission(authority, "canWrite");
    return reportErrors(() => operatingService.previewFacts(authority.scope, input));
  }),
  confirmFacts: businessRead.input(confirmFactsInput).mutation(({ ctx: { authority }, input }) => {
    requirePermission(authority, "canWrite");
    return reportErrors(() => operatingService.confirmFacts(authority.scope, input));
  }),
  listFacts: businessRead.input(listFactsInput.optional()).query(({ ctx: { authority }, input }) =>
    reportErrors(() => operatingService.listFacts(authority.scope, input ?? {}))),
  getEvidence: businessRead.input(evidenceInput).query(({ ctx: { authority }, input }) =>
    reportErrors(() => operatingService.listFacts(authority.scope, { ...input, limit: input.factIds.length }))),
  getBrief: businessRead.input(getBriefInput.optional()).query(({ ctx: { authority }, input }) =>
    reportErrors(() => operatingService.getBrief(authority.scope, input ?? {}))),
  review: businessRead.input(reviewInput).query(({ ctx: { authority }, input }) =>
    reportErrors(() => operatingService.review(authority.scope, input))),
  listActions: businessRead.input(listActionsInput.optional()).query(({ ctx: { authority }, input }) =>
    reportErrors(() => operatingService.listActions(authority.scope, input ?? {}))),
  outcomeEvidence: businessRead.input(listOutcomeEvidenceInput).query(({ ctx: { authority }, input }) => {
    requirePermission(authority, "canWrite");
    return reportErrors(() => operatingService.listOutcomeEvidence(authority.scope, input));
  }),
  confirmAction: businessRead.input(confirmActionInput).mutation(({ ctx: { authority }, input }) => {
    requirePermission(authority, "canConfirmAction");
    return reportErrors(() => operatingService.confirmAction(authority.scope, input));
  }),
  recordActionOutcome: businessRead.input(recordActionOutcomeInput).mutation(({ ctx: { authority }, input }) => {
    requirePermission(authority, "canWrite");
    return reportErrors(() => operatingService.recordActionOutcome(authority.scope, input));
  }),
  verifyActionOutcome: businessRead.input(verifyActionOutcomeInput).mutation(({ ctx: { authority }, input }) => {
    requirePermission(authority, "canConfirmAction");
    return reportErrors(() => operatingService.verifyActionOutcome(authority.scope, input));
  }),

  botStatus: businessRead.query(async ({ ctx: { authority } }) => {
    requirePermission(authority, "canManage");
    return reportErrors(async () => {
      const [mandates, tasks, worker] = await Promise.all([
        operatingBot.listMandates(authority.scope), operatingBot.listTasks(authority.scope),
        operatingBot.getWorkerStatus(authority.scope),
      ]);
      return { capabilities: BOT_CAPABILITIES, mandates, tasks, worker };
    });
  }),
  grantMandate: businessRead.input(createMandateInput.omit({ businessUnit: true })).mutation(({ ctx: { authority }, input }) => {
    requirePermission(authority, "canConfigureBot");
    return reportErrors(() => operatingBot.createMandate(authority.scope, authority.actor,
      { ...input, businessUnit: authority.scope.workspaceId }));
  }),
  revokeMandate: businessRead.input(mandateInput).mutation(({ ctx: { authority }, input }) => {
    requirePermission(authority, "canConfigureBot");
    return reportErrors(() => operatingBot.revokeMandate(authority.scope, authority.actor, input.mandateId));
  }),
  submitTask: businessRead.input(manualTaskInput).mutation(({ ctx: { authority }, input }) => {
    requirePermission(authority, "canDispatchBot");
    return reportErrors(() => operatingBot.enqueueManual(authority.scope, authority.actor, input));
  }),
  taskView: businessRead.input(taskInput).query(({ ctx: { authority }, input }) => {
    requirePermission(authority, "canManage");
    return reportErrors(() => operatingBot.getTask(authority.scope, input.taskId));
  }),
  taskEvents: businessRead.input(taskEventsInput).query(({ ctx: { authority }, input }) => {
    requirePermission(authority, "canManage");
    return reportErrors(() => operatingBot.listEvents(authority.scope, input));
  }),
  cancelTask: businessRead.input(taskInput).mutation(({ ctx: { authority }, input }) => {
    requirePermission(authority, "canDispatchBot");
    return reportErrors(() => operatingBot.cancelTask(authority.scope, authority.actor, input.taskId));
  }),
});
