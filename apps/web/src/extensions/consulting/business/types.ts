import type { TRPCClient } from "@trpc/client";
import type { AppRouter } from "@workloom/server/router";

type BusinessClient = TRPCClient<AppRouter>["business"];

export type BusinessContext = Awaited<ReturnType<BusinessClient["context"]["query"]>>;
export type Brief = NonNullable<Awaited<ReturnType<BusinessClient["getBrief"]["query"]>>>;
export type BotStatus = Awaited<ReturnType<BusinessClient["botStatus"]["query"]>>;
export type PreviewInput = Parameters<BusinessClient["previewFacts"]["mutate"]>[0];
export type Preview = Awaited<ReturnType<BusinessClient["previewFacts"]["mutate"]>>;
export type OperatingAction = Awaited<ReturnType<BusinessClient["listActions"]["query"]>>[number];
export type OperatingFact = Awaited<ReturnType<BusinessClient["listFacts"]["query"]>>[number];
