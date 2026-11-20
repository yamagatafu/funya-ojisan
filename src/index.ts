import { factory } from './factory.ts';
import { transporterHandlers } from './handlers/transporter.ts';

export default factory.discord().loader(transporterHandlers);
