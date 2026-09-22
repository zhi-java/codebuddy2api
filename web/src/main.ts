import { createApp } from 'vue';
import App from './App.vue';
import './tokens.css'; // 设计令牌（唯一事实源）—— 必须最先引入
import './fonts.css';
import './styles.css';

createApp(App).mount('#app');
