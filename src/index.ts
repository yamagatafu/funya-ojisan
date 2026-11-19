import { factory } from './factory.ts';
import { transporterHandlers } from './handlers/transporter.ts';

export const app = factory.discord().loader(transporterHandlers);

export default app;
