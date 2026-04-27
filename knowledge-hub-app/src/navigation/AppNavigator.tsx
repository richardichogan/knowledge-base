/**
 * Root navigator: Bottom tabs with stack navigators per tab.
 */

import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { NavigationContainer } from '@react-navigation/native';
import { TimelineScreen } from '../screens/Timeline/TimelineScreen';
import { SearchScreen } from '../screens/Search/SearchScreen';
import { AIChatScreen } from '../screens/AIChat/AIChatScreen';
import { TasksScreen } from '../screens/Tasks/TasksScreen';
import { CalendarScreen } from '../screens/Calendar/CalendarScreen';

export type RootTabParamList = {
  Timeline: undefined;
  Search: undefined;
  AIChat: undefined;
  Tasks: undefined;
  Calendar: undefined;
};

const Tab = createBottomTabNavigator<RootTabParamList>();

/**
 * App-level navigator. Renders a bottom tab bar with five tabs.
 */
export const AppNavigator: React.FC = () => {
  return (
    <NavigationContainer>
      <Tab.Navigator
        screenOptions={{
          headerShown: true,
          tabBarActiveTintColor: '#0078D4',
        }}
      >
        <Tab.Screen
          name="Timeline"
          component={TimelineScreen}
          options={{ title: 'Timeline' }}
        />
        <Tab.Screen
          name="Search"
          component={SearchScreen}
          options={{ title: 'Search' }}
        />
        <Tab.Screen
          name="AIChat"
          component={AIChatScreen}
          options={{ title: 'AI Chat' }}
        />
        <Tab.Screen
          name="Tasks"
          component={TasksScreen}
          options={{ title: 'Tasks' }}
        />
        <Tab.Screen
          name="Calendar"
          component={CalendarScreen}
          options={{ title: 'Calendar' }}
        />
      </Tab.Navigator>
    </NavigationContainer>
  );
};
