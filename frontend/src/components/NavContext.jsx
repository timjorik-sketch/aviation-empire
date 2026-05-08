import { createContext, useContext } from 'react';

export const NavContext = createContext(null);

export function useNav() {
  return useContext(NavContext);
}
