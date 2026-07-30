# EXCELLER

EXCELLER is a React + Vite web application for building, managing, and running proctored exams. The app provides a simple workflow for creating exam content, launching a test experience, and reviewing submitted results.

## Features

- Create and edit exams from the builder interface
- Launch a proctored test player for participants
- View and review exam submissions in a dedicated dashboard
- Connect to Supabase for data persistence

## Tech Stack

- React 19
- Vite
- React Router
- Tailwind CSS
- Supabase

## Getting Started

1. Install dependencies:
   ```bash
   npm install
   ```

2. Create a local environment file with your Supabase credentials:
   ```bash
   VITE_SUPABASE_URL=your_supabase_url
   VITE_SUPABASE_ANON_KEY=your_supabase_anon_key
   ```

3. Start the development server:
   ```bash
   npm run dev
   ```

## Available Scripts

- `npm run dev` – start the local Vite development server
- `npm run build` – build the project for production
- `npm run preview` – preview the production build locally
- `npm run lint` – run ESLint checks

## Project Structure

```text
src/
  components/     # Exam builder, player, dashboard, and editor UI
  lib/            # Shared client and utility modules
  App.jsx         # Main routes and navigation
```

## Notes

The app expects Supabase environment variables to be available at runtime. If they are missing, the app will stop with an error until the required values are configured.
