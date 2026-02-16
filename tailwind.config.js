/** @type {import('tailwindcss').Config} */
export default {
    content: [
        "./index.html",
        "./src/**/*.{js,ts,jsx,tsx}",
    ],
    darkMode: 'class', // Use 'class' strategy for manual toggle
    theme: {
        extend: {
            zIndex: {
                '100': '100',
            }
        },
    },
    plugins: [],
}
