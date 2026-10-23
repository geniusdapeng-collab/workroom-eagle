/** Industry-owned API. Generic agents receive no arbitrary tool, SQL, stage or completion-write endpoint. */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { actionProcedure, protectedProcedure, router, scopeOf } from "../../trpc/context.js";
import { ConsultingError, sourceSchema } from "./workflow-core.js";
import { consultingWorkflow, type ConsultingRun } from "./workflow.js";

const enterpriseId = z.string().min(1).max(80).regex(/^[A-Za-z0-9_\-\u3400-\u9fff]+$/u);
const idempotencyKey = z.string().min(8).max(160);
const runId = z.string().regex(/^CR-[a-f0-9]{24}$/);
const transitionInput = z.object({ runId, idempotencyKey }).strict();
async function handled<T>(body: () => Promise<T>): Promise<T> {
  try { return await body(); }
  catch (error) {
    if (!(error instanceof ConsultingError)) throw error;
    const code = error.code === "NOT_FOUND" ? "NOT_FOUND"
      : error.code === "IDEMPOTENCY_CONFLICT" ? "CONFLICT"
      : /INVALID|TOO_LARGE|NOT_ASSIGNED|NOT_FOUND/.test(error.code) ? "BAD_REQUEST" : "PRECONDITION_FAILED";
    throw new TRPCError({ code, message: `[${error.code}] ${error.message}` });
  }
}
function result(capabilityId: string, value: ConsultingRun) {
  return { schemaVersion: "workloom.capability-result/v1", capabilityId, operation: "execute",
    status: value.status === "draft_ready" ? "succeeded" : value.status === "blocked" ? "failed" : "pending",
    dataMode: "real", result: value, receipt: value.lastReceipt };
}

export const consultingRouter = router({
  catalog: protectedProcedure.query(({ ctx }) => handled(() => consultingWorkflow.catalog(scopeOf(ctx.identity)))),
  dossierPut: actionProcedure("workspace.write")
    .input(z.object({ enterpriseId, sources: z.array(sourceSchema).min(1).max(8), idempotencyKey }).strict())
    .mutation(({ ctx, input }) => handled(async () => {
      const value = await consultingWorkflow.dossierPut(scopeOf(ctx.identity), ctx.identity.memberNo, input);
      return { schemaVersion: "workloom.capability-result/v1", capabilityId: "consulting.dossier.put", operation: "execute",
        status: "succeeded", dataMode: "real", result: value, receipt: value.receipt };
    })),
  dossierGet: protectedProcedure.input(z.object({ enterpriseId }).strict())
    .query(({ ctx, input }) => handled(() => consultingWorkflow.dossierGet(scopeOf(ctx.identity), input.enterpriseId))),
  submit: actionProcedure("task.dispatch")
    .input(z.object({ enterpriseId, goal: z.string().min(8).max(500), employeeKey: z.string().min(1).max(80).optional(),
      skillId: z.string().min(1).max(80).optional(), idempotencyKey }).strict())
    .mutation(({ ctx, input }) => handled(async () => result("consulting.workflow.submit",
      await consultingWorkflow.submit(scopeOf(ctx.identity), ctx.identity.memberNo, input)))),
  advance: actionProcedure("task.dispatch").input(transitionInput)
    .mutation(({ ctx, input }) => handled(async () => result("consulting.workflow.advance",
      await consultingWorkflow.advance(scopeOf(ctx.identity), ctx.identity.memberNo, input)))),
  revalidate: actionProcedure("task.dispatch").input(transitionInput)
    .mutation(({ ctx, input }) => handled(async () => result("consulting.workflow.revalidate",
      await consultingWorkflow.revalidate(scopeOf(ctx.identity), ctx.identity.memberNo, input)))),
  pause: actionProcedure("task.dispatch").input(transitionInput)
    .mutation(({ ctx, input }) => handled(async () => result("consulting.workflow.pause",
      await consultingWorkflow.pauseOrResume(scopeOf(ctx.identity), ctx.identity.memberNo, input, true)))),
  resume: actionProcedure("task.dispatch").input(transitionInput)
    .mutation(({ ctx, input }) => handled(async () => result("consulting.workflow.resume",
      await consultingWorkflow.pauseOrResume(scopeOf(ctx.identity), ctx.identity.memberNo, input, false)))),
  get: protectedProcedure.input(z.object({ runId }).strict())
    .query(({ ctx, input }) => handled(() => consultingWorkflow.get(scopeOf(ctx.identity), input.runId))),
  artifact: protectedProcedure.input(z.object({ runId, stepId: z.string().regex(/^s[1-6]$/) }).strict())
    .query(({ ctx, input }) => handled(() => consultingWorkflow.artifact(scopeOf(ctx.identity), input.runId, input.stepId))),
});
