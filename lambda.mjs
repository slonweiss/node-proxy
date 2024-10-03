import { handler as serverHandler } from "./server.js";

export const handler = async (event, context) => {
  return await serverHandler(event, context);
};
