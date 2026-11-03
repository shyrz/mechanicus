const bubble = document.getElementById('bubble');
const api = window.__TAURI__;
let latestGeneration = 0;

if (api) {
  (async () => {
    await api.event.listen(
      'companion://tooltip-content',
      async ({ payload }) => {
        const { generation, project } = payload;
        if (generation < latestGeneration) return;
        latestGeneration = generation;
        bubble.textContent = project;
        bubble.style.removeProperty('max-width');
        const bounds = bubble.getBoundingClientRect();
        const placement = await api.core.invoke('measure_project_tooltip', {
          generation,
          width: Math.ceil(bounds.width),
          height: Math.ceil(bounds.height),
        });
        if (!placement || generation !== latestGeneration) return;
        if (placement.max_width) {
          bubble.style.setProperty('max-width', `${placement.max_width}px`);
          const adjusted = bubble.getBoundingClientRect();
          const finalPlacement = await api.core.invoke(
            'measure_project_tooltip',
            {
              generation,
              width: Math.ceil(adjusted.width),
              height: Math.ceil(adjusted.height),
            },
          );
          if (!finalPlacement || generation !== latestGeneration) return;
          Object.assign(placement, finalPlacement);
        }
        document.body.classList.toggle('above', placement.above);
        bubble.style.setProperty('--tail-x', `${placement.tail_x}px`);
        await api.core.invoke('show_project_tooltip', { generation });
      },
    );
    await api.core.invoke('project_tooltip_ready');
  })().catch((error) => console.error('[companion] tooltip failed', error));
}
