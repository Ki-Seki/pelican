import { createContext, useContext } from 'react';

/** The session a message list shows, for parts deep inside it (an Agent call loading its own steps). */
export const SessionContext = createContext<string | undefined>(undefined);

export const useSessionId = () => useContext(SessionContext);
